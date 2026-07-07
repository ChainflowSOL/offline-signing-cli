// Attacker attempts against broadcast.ts client-side defenses.
// broadcast.ts has these gates before sending any RPC:
//   1. version == vector-v1 (both files)
//   2. unsigned.action == signed.action
//   3. unsigned.coldAddress == signed.coldAddress
//   4. hot-wallet keypair pubkey == unsigned.feePayer
//   5. nacl.sign.detached.verify(digest, sig, coldPubkey)
// Each of these must reject a matching adversarial input BEFORE hitting the network.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import {
  digestExecute,
  encodeSubInstructions,
  findVaultPda,
} from "../src/utils/vector";
import { serializeInstruction } from "../src/utils/io";

const REPO = path.resolve(__dirname, "..");
const SCRATCH = path.resolve(__dirname);

const coldKp = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(fs.readFileSync(path.join(SCRATCH, "cold-test.json"), "utf-8")))
);
const cold = coldKp.publicKey;
const [vault] = findVaultPda(cold);
const alice = new PublicKey("3iAnUKLYgszyh9A3HZxnSnuhhu7kRYY7edAxTP2R9MfC");
const attacker = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

// Load the real hot-wallet keypair so we can construct payloads that reference it.
const hotKp = Keypair.fromSecretKey(
  new Uint8Array(
    JSON.parse(
      fs.readFileSync(path.join(process.env.HOME!, ".config/solana/id.json"), "utf-8")
    )
  )
);
const hot = hotKp.publicKey;

const seed = Buffer.alloc(32, 0xab);
const benignIx = SystemProgram.transfer({
  fromPubkey: vault,
  toPubkey: alice,
  lamports: 1_000_000,
});
const benignData = encodeSubInstructions([benignIx]);
const benignDigest = digestExecute(seed, benignData);
const benignSig = Buffer.from(nacl.sign.detached(benignDigest, coldKp.secretKey));

function baseUnsigned() {
  return {
    version: "vector-v1" as const,
    action: "execute" as const,
    description: "Transfer 0.001 SOL to Alice",
    network: "devnet",
    coldAddress: cold.toBase58(),
    feePayer: hot.toBase58(),
    seedBase64: seed.toString("base64"),
    digestBase64: benignDigest.toString("base64"),
    subInstructions: [benignIx].map(serializeInstruction),
    meta: {
      tokenSymbol: "SOL",
      decimals: 9,
      amount: 0.001,
      recipient: alice.toBase58(),
    },
  };
}

function baseSigned() {
  return {
    version: "vector-v1" as const,
    action: "execute" as const,
    coldAddress: cold.toBase58(),
    signatureBase64: benignSig.toString("base64"),
  };
}

interface Case {
  name: string;
  unsigned: object;
  signed: object;
  // regex the CLI stderr/stdout must contain to be considered a valid rejection.
  expectReject: RegExp;
  // path to keypair file to use as --payer (default = hot)
  payer?: string;
}

const wrongKp = Keypair.generate();
fs.writeFileSync(path.join(SCRATCH, "wrong-hot.json"), JSON.stringify(Array.from(wrongKp.secretKey)));

const cases: Case[] = [
  {
    name: "B1-action-mismatch",
    unsigned: { ...baseUnsigned(), action: "execute" },
    signed: { ...baseSigned(), action: "close" },
    expectReject: /Action mismatch/,
  },
  {
    name: "B2-coldAddress-mismatch",
    unsigned: baseUnsigned(),
    signed: { ...baseSigned(), coldAddress: attacker.toBase58() },
    expectReject: /coldAddress mismatch/,
  },
  {
    name: "B3-wrong-payer-keypair",
    unsigned: baseUnsigned(),
    signed: baseSigned(),
    expectReject: /does not match feePayer/,
    payer: path.join(SCRATCH, "wrong-hot.json"),
  },
  {
    name: "B4-tampered-signature",
    unsigned: baseUnsigned(),
    signed: {
      ...baseSigned(),
      signatureBase64: Buffer.from(nacl.sign.detached(benignDigest, Keypair.generate().secretKey)).toString("base64"),
    },
    expectReject: /Signature does not verify/,
  },
  {
    name: "B5-swap-subix-after-sign-recompute-digest",
    // Attacker swaps subInstructions AND digestBase64 to match, keeping the
    // legit signature. sig was over ORIGINAL digest → verify(new_digest, old_sig)
    // fails. This is the load-bearing defense.
    unsigned: (() => {
      const evil = SystemProgram.transfer({
        fromPubkey: vault,
        toPubkey: attacker,
        lamports: 999_000_000,
      });
      const u = baseUnsigned() as any;
      u.subInstructions = [evil].map(serializeInstruction);
      u.digestBase64 = digestExecute(seed, encodeSubInstructions([evil])).toString("base64");
      return u;
    })(),
    signed: baseSigned(), // unchanged — signature over original digest
    expectReject: /Signature does not verify/,
  },
  {
    name: "B6-swap-subix-without-recomputing-digest",
    // Attacker swaps only subInstructions. Signature still verifies against
    // the unchanged digest, but on-chain the program will recompute from the
    // MALICIOUS sub_ix_data and get a different digest → precompile check fails.
    // (This case's client-side check will PASS locally, but the tx would
    // definitely fail on chain. We record it as CLIENT-PASS+CHAIN-FAIL and
    // note that the reject is delegated to the on-chain layer.)
    unsigned: (() => {
      const evil = SystemProgram.transfer({
        fromPubkey: vault,
        toPubkey: attacker,
        lamports: 999_000_000,
      });
      const u = baseUnsigned() as any;
      u.subInstructions = [evil].map(serializeInstruction);
      // digestBase64 NOT changed — still points to the benign digest
      return u;
    })(),
    signed: baseSigned(),
    expectReject: /CLIENT-PASS/, // custom marker — see driver
  },
];

const results: { name: string; passed: boolean; note: string }[] = [];
for (const c of cases) {
  const uFile = path.join(SCRATCH, `bcast-${c.name}-unsigned.json`);
  const sFile = path.join(SCRATCH, `bcast-${c.name}-signed.json`);
  fs.writeFileSync(uFile, JSON.stringify(c.unsigned, null, 2));
  fs.writeFileSync(sFile, JSON.stringify(c.signed, null, 2));

  const payer = c.payer ?? path.join(process.env.HOME!, ".config/solana/id.json");
  let stdout = "";
  try {
    stdout = execSync(
      `pnpm exec ts-node src/index.ts broadcast --env devnet --unsigned ${uFile} --signature ${sFile} --payer ${payer}`,
      { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e: any) {
    stdout = (e.stdout ?? "").toString() + (e.stderr ?? "").toString();
  }

  let passed = false;
  let note = "";
  if (c.expectReject.source === "CLIENT-PASS") {
    // client-side accepts; on-chain rejection expected but not tested here
    // The signal we want: broadcast attempts to send (would fail on chain but
    // client checks passed). We can't verify chain without RPC, but we can
    // verify no client-side reject happened.
    const rejected =
      /Action mismatch|coldAddress mismatch|does not match feePayer|Signature does not verify/.test(
        stdout
      );
    // Since we can't hit the network, expect an RPC error, not a client reject.
    passed = !rejected;
    note = passed
      ? "client checks pass (on-chain would reject; not tested here due to RPC block)"
      : "client-side REJECTED unexpectedly";
  } else {
    passed = c.expectReject.test(stdout);
    note = passed ? "rejected client-side as expected" : "did NOT reject as expected";
  }
  results.push({ name: c.name, passed, note });
  fs.rmSync(uFile, { force: true });
  fs.rmSync(sFile, { force: true });
}

fs.rmSync(path.join(SCRATCH, "wrong-hot.json"), { force: true });

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║             BROADCAST-TIME ATTACKER TEST RESULTS                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
for (const r of results) {
  const mark = r.passed ? "✓" : "✗";
  console.log(`  ${mark}  ${r.name.padEnd(50)} — ${r.note}`);
}
const failing = results.filter((r) => !r.passed);
console.log();
console.log(
  `RESULT: ${results.length - failing.length}/${results.length} passed` +
    (failing.length ? ` — ${failing.length} FAILED` : "")
);
process.exit(failing.length ? 1 : 0);
