import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as readline from "readline";
import nacl from "tweetnacl";
import { loadJson, saveJson, SignedTxJson, UnsignedTxJson } from "../utils/io";

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

  if (tx.action === "execute") {
    if (tx.meta) {
      console.log(`  Amount:    ${tx.meta.amount} ${tx.meta.tokenSymbol}`);
      console.log(`  Recipient: ${tx.meta.recipient}`);
    } else {
      console.log(`  Description: ${tx.description}`);
    }
  } else {
    console.log(`  Close-to (rent destination): ${tx.closeTo}`);
  }
  console.log("---------------------------------------------------------");

  if (!(await confirm('\nCONFIRM: type "yes" to sign: '))) {
    console.log("\nABORTED. Nothing signed.");
    return;
  }

  const digest = Buffer.from(tx.digestBase64, "base64");
  if (digest.length !== 32) {
    throw new Error(`Digest must be 32 bytes; got ${digest.length}.`);
  }

  const signature = nacl.sign.detached(digest, keypair.secretKey);

  const signed: SignedTxJson = {
    version: "vector-v1",
    action: tx.action,
    coldAddress: keypair.publicKey.toBase58(),
    signatureBase64: Buffer.from(signature).toString("base64"),
  };

  saveJson("signed-tx.json", signed);
  console.log(`\nNEXT STEP: Move 'signed-tx.json' back ONLINE and run 'broadcast'.`);
}
