import { Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as readline from "readline";
import nacl from "tweetnacl";
import {
  deserializeInstruction,
  loadJson,
  saveJson,
  SignedTxJson,
  UnsignedTxJson,
} from "../utils/io";
import { digestClose, digestExecute, encodeSubInstructions } from "../utils/vector";
import { describeSubInstructions } from "../utils/describe";

function loadColdKeypair(keypairPath: string): Keypair {
  if (!fs.existsSync(keypairPath)) {
    throw new Error(`Cold-wallet keypair not found at: ${keypairPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const secret = Array.isArray(raw)
    ? Uint8Array.from(raw)
    : new Uint8Array(Object.values(raw._keypair?.secretKey ?? raw));
  return Keypair.fromSecretKey(secret);
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(prompt, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "yes";
}

export async function signOffline(
  keypairPath: string,
  unsignedPath: string
): Promise<void> {
  const keypair = loadColdKeypair(keypairPath);
  const tx = loadJson<UnsignedTxJson>(unsignedPath);

  if (tx.version !== "vector-v1") {
    throw new Error(
      `Unknown unsigned-tx version: ${(tx as { version?: string }).version}. Expected 'vector-v1'.`
    );
  }

  console.log("=========================================================");
  console.log("                  OFFLINE SIGNING REQUEST                ");
  console.log("=========================================================");
  console.log(`  Network:        ${tx.network.toUpperCase()}`);
  console.log(`  Action:         ${tx.action.toUpperCase()}`);
  console.log(`  Signer:         ${keypair.publicKey.toBase58()}`);
  console.log(`  Vector authority: ${tx.coldAddress}`);
  console.log(`  Fee payer:      ${tx.feePayer}`);

  if (tx.coldAddress !== keypair.publicKey.toBase58()) {
    console.error(
      `\nERROR: Loaded keypair (${keypair.publicKey.toBase58()}) does not match ` +
        `the Vector authority in this transaction (${tx.coldAddress}).`
    );
    process.exit(1);
  }

  // ── Independently verify the digest BEFORE showing or signing anything ──
  // The signer trusts nothing the (untrusted) producer wrote except the raw
  // sub-instructions / closeTo, which it re-hashes with the public on-chain
  // seed and compares byte-for-byte against the digest it is being asked to
  // sign. This is what makes "what you see is what you sign" hold even when the
  // producing (online) machine is compromised.
  if (typeof tx.seedBase64 !== "string" || tx.seedBase64.length === 0) {
    throw new Error(
      "Unsigned tx is missing 'seedBase64'. Regenerate it with an up-to-date CLI; " +
        "this signer refuses to blind-sign an opaque digest."
    );
  }
  const seed = Buffer.from(tx.seedBase64, "base64");
  if (seed.length !== 32) {
    throw new Error(`seed must be 32 bytes; got ${seed.length}.`);
  }

  let expected: Buffer;
  let actionLines: string[];
  if (tx.action === "execute") {
    const subIxs = tx.subInstructions.map(deserializeInstruction);
    expected = digestExecute(seed, encodeSubInstructions(subIxs));
    actionLines = [
      "  Action: EXECUTE the following sub-instruction(s):",
      ...describeSubInstructions(subIxs),
    ];
  } else {
    const closeTo = new PublicKey(tx.closeTo);
    expected = digestClose(seed, closeTo);
    actionLines = [
      "  Action: CLOSE the Vector account.",
      "        -> drains the ENTIRE vault balance + state-account rent to:",
      `           ${closeTo.toBase58()}`,
    ];
  }

  const claimed = Buffer.from(tx.digestBase64, "base64");
  if (claimed.length !== 32 || !expected.equals(claimed)) {
    console.error(
      "\nREFUSING TO SIGN: the digest in this file does not match its own instructions."
    );
    console.error(`  recomputed (from instructions): ${expected.toString("base64")}`);
    console.error(`  digest in file:                 ${tx.digestBase64}`);
    console.error(
      "  The file was tampered with, targets a different on-chain seed, or came " +
        "from an incompatible tool. Nothing signed."
    );
    process.exit(1);
  }

  for (const line of actionLines) console.log(line);
  if (tx.description) {
    console.log("  ---");
    console.log(`  Producer label (UNVERIFIED): ${tx.description}`);
  }
  console.log("---------------------------------------------------------");

  if (!(await confirm('\nCONFIRM: type "yes" to sign the action shown above: '))) {
    console.log("\nABORTED. Nothing signed.");
    return;
  }

  // Sign the digest we recomputed ourselves (== the verified `claimed`).
  const signature = nacl.sign.detached(expected, keypair.secretKey);

  const signed: SignedTxJson = {
    version: "vector-v1",
    action: tx.action,
    coldAddress: keypair.publicKey.toBase58(),
    signatureBase64: Buffer.from(signature).toString("base64"),
  };

  saveJson("signed-tx.json", signed);
  console.log(`\nNEXT STEP: Move 'signed-tx.json' back ONLINE and run 'broadcast'.`);
}
