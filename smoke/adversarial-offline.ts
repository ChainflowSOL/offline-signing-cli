// Adversarial offline test suite against sign.ts.
// Each case is either an attack we want *refused* (REFUSE),
// or an attack that *passes structural checks* (PASS-BUT-SHOW-TRUTH)
// where the sign UI must still surface the real action so a human catches it.
//
// Run: pnpm exec ts-node smoke/adversarial-offline.ts
// The script only WRITES the files; the driver at the bottom of the script
// invokes `sign` for each and reports the outcome.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  PublicKey,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  digestClose,
  digestExecute,
  encodeSubInstructions,
  findVaultPda,
  VECTOR_PROGRAM_ID,
} from "../src/utils/vector";
import { serializeInstruction } from "../src/utils/io";
import { keyPath, loadOrCreate } from "./testkeys";

// The CLI under test. Defaults to the TypeScript source; set OFS_CLI to a
// packaged binary to run these same checks against a release artifact, e.g.
//   OFS_CLI=./dist/executables/offline-signer-linux-x64 pnpm exec ts-node smoke/...
const CLI = process.env.OFS_CLI ?? "pnpm exec ts-node src/index.ts";


const cold = loadOrCreate("cold-test").publicKey;
const hot = new PublicKey("6bZJmyGwb3i1XkhjsrkrHHqkAAB82g1AwgqM2rY2zZWF");
const alice = new PublicKey("3iAnUKLYgszyh9A3HZxnSnuhhu7kRYY7edAxTP2R9MfC");
// Distinct attacker pubkey (BPF Loader Upgradeable — any different key works).
const attacker = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const other = new PublicKey("So11111111111111111111111111111111111111112"); // wSOL mint
const [vault] = findVaultPda(cold);
const seed = Buffer.alloc(32, 0xab);

function transferIx(from: PublicKey, to: PublicKey, lamports: number) {
  return SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
}

function payload(overrides: Record<string, unknown>) {
  const benign = transferIx(vault, alice, 1_000_000);
  const base = {
    version: "vector-v1" as const,
    action: "execute" as const,
    description: "Transfer 0.001 SOL to Alice",
    network: "devnet",
    coldAddress: cold.toBase58(),
    feePayer: hot.toBase58(),
    seedBase64: seed.toString("base64"),
    digestBase64: digestExecute(seed, encodeSubInstructions([benign])).toString("base64"),
    subInstructions: [benign].map(serializeInstruction),
    meta: {
      tokenSymbol: "SOL",
      decimals: 9,
      amount: 0.001,
      recipient: alice.toBase58(),
    },
  };
  return { ...base, ...overrides };
}

const SCRATCH = path.resolve(__dirname);

interface Case {
  name: string;
  expect: "REFUSE" | "PASS-BUT-SHOW-TRUTH";
  build: () => object;
  // Substring the sign output must contain to be considered "showing truth"
  mustContain?: string;
}

const cases: Case[] = [
  {
    name: "01-baseline-valid",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => payload({}),
    mustContain: "SOL TRANSFER 0.001 SOL",
  },
  {
    name: "02-attack-mismatched-meta-drain",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => {
      const evil = transferIx(vault, attacker, 999_999_999);
      return payload({
        digestBase64: digestExecute(seed, encodeSubInstructions([evil])).toString("base64"),
        subInstructions: [evil].map(serializeInstruction),
        // meta unchanged - the LIE
      });
    },
    mustContain: "SOL TRANSFER 0.999999999 SOL",
  },
  {
    name: "03-digest-vs-subix-mismatch",
    expect: "REFUSE",
    build: () => {
      const evil = transferIx(vault, attacker, 999_999_999);
      return payload({
        digestBase64: digestExecute(seed, encodeSubInstructions([evil])).toString("base64"),
        // subInstructions NOT changed - benign, but digest says drain
      });
    },
  },
  {
    name: "04-missing-seed",
    expect: "REFUSE",
    build: () => {
      const p = payload({}) as Record<string, unknown>;
      delete p.seedBase64;
      return p;
    },
  },
  {
    name: "05-wrong-length-seed",
    expect: "REFUSE",
    build: () => payload({ seedBase64: Buffer.alloc(31, 0xab).toString("base64") }),
  },
  {
    name: "06-wrong-cold-address",
    expect: "REFUSE",
    build: () => payload({ coldAddress: attacker.toBase58() }),
  },
  {
    name: "07-unknown-version",
    expect: "REFUSE",
    build: () => payload({ version: "vector-v2" }),
  },
  {
    name: "08-close-mismatched-closeTo",
    expect: "REFUSE",
    build: () => {
      // producer publishes closeTo=alice but digest binds attacker
      const evilDigest = digestClose(seed, attacker);
      return {
        version: "vector-v1" as const,
        action: "close" as const,
        description: "Close to Alice",
        network: "devnet",
        coldAddress: cold.toBase58(),
        feePayer: hot.toBase58(),
        seedBase64: seed.toString("base64"),
        digestBase64: evilDigest.toString("base64"),
        closeTo: alice.toBase58(),
      };
    },
  },
  {
    name: "09-close-valid",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => ({
      version: "vector-v1" as const,
      action: "close" as const,
      description: "Close to Alice",
      network: "devnet",
      coldAddress: cold.toBase58(),
      feePayer: hot.toBase58(),
      seedBase64: seed.toString("base64"),
      digestBase64: digestClose(seed, alice).toString("base64"),
      closeTo: alice.toBase58(),
    }),
    mustContain: "drains the ENTIRE vault balance",
  },
  {
    name: "10-unknown-program-subix",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => {
      // Use our own program ID as the "unknown" sub-ix program — that's a
      // recognized-but-not-in-KNOWN_PROGRAMS pubkey.
      const unk = new TransactionInstruction({
        programId: new PublicKey(VECTOR_PROGRAM_ID),
        keys: [
          { pubkey: vault, isSigner: false, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
      });
      return payload({
        subInstructions: [unk].map(serializeInstruction),
        digestBase64: digestExecute(seed, encodeSubInstructions([unk])).toString("base64"),
      });
    },
    mustContain: "UNRECOGNIZED INSTRUCTION",
  },
  {
    name: "11-multi-subix-hidden-drainer",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => {
      const benign = transferIx(vault, alice, 1_000_000);
      const drain = transferIx(vault, attacker, 999_000_000);
      const both = [benign, drain];
      return payload({
        subInstructions: both.map(serializeInstruction),
        digestBase64: digestExecute(seed, encodeSubInstructions(both)).toString("base64"),
        // meta: still claims only "0.001 SOL to Alice"
      });
    },
    mustContain: "SOL TRANSFER 0.999 SOL",
  },
  {
    name: "12-malformed-transfer-data-forces-raw-dump",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => {
      // System.transfer discriminator 2 but truncated data
      const bad = new TransactionInstruction({
        programId: SystemProgram.programId,
        keys: [
          { pubkey: vault, isSigner: true, isWritable: true },
          { pubkey: attacker, isSigner: false, isWritable: true },
        ],
        data: Buffer.from([2, 0, 0, 0]), // disc=2 but only 4 bytes total, needs >=12
      });
      return payload({
        subInstructions: [bad].map(serializeInstruction),
        digestBase64: digestExecute(seed, encodeSubInstructions([bad])).toString("base64"),
      });
    },
    // must fall through to raw dump instead of misleading SOL TRANSFER summary
    mustContain: "UNRECOGNIZED INSTRUCTION",
  },
  {
    name: "13-stake-delegate-decoded",
    expect: "PASS-BUT-SHOW-TRUTH",
    build: () => {
      const validator = new PublicKey("deepPy86gApSci6B3QHsncudzQBMNX8f6Wwwsz64bUz");
      const stakeAcct = new PublicKey("EFA12ymJ1Apyo8tjcmw1L89WSiTZxkuEe5yAN1DXMsjL");
      const delegateTx = StakeProgram.delegate({
        stakePubkey: stakeAcct,
        authorizedPubkey: vault,
        votePubkey: validator,
      });
      const ix = delegateTx.instructions[0]!;
      return payload({
        subInstructions: [ix].map(serializeInstruction),
        digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString("base64"),
        meta: {
          stakeAction: "delegate",
          stakePubkey: stakeAcct.toBase58(),
          validatorVotePubkey: validator.toBase58(),
        },
      });
    },
    mustContain: "STAKE DELEGATE",
  },
];

// ── Driver ────────────────────────────────────────────────────────────

const REPO = path.resolve(__dirname, "..");
const results: { name: string; expect: string; passed: boolean; note: string }[] = [];

for (const c of cases) {
  const file = path.join(SCRATCH, `adv-${c.name}.json`);
  fs.writeFileSync(file, JSON.stringify(c.build(), null, 2));

  let stdout = "";
  let refused = false;
  let signed = false;
  try {
    stdout = execSync(
      `echo yes | ${CLI} sign --keypair ${keyPath("cold-test")} --unsigned ${file}`,
      { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
    );
  } catch (e: any) {
    stdout = (e.stdout ?? "").toString() + (e.stderr ?? "").toString();
  }
  refused =
    /REFUSING TO SIGN/.test(stdout) ||
    /missing 'seedBase64'/.test(stdout) ||
    /seed must be 32 bytes/.test(stdout) ||
    /does not match/.test(stdout) ||
    /Unknown unsigned-tx version/.test(stdout);
  signed = /Saved to.*signed-tx\.json/.test(stdout);

  let passed = false;
  let note = "";
  if (c.expect === "REFUSE") {
    passed = refused && !signed;
    note = passed ? "refused as expected" : "DID NOT refuse — attack succeeded";
  } else {
    // PASS-BUT-SHOW-TRUTH
    const showedTruth = c.mustContain ? stdout.includes(c.mustContain) : true;
    passed = signed && showedTruth;
    note = signed
      ? showedTruth
        ? "signed and displayed truth"
        : `signed but UI missing "${c.mustContain}"`
      : "did not sign (unexpected)";
  }
  results.push({ name: c.name, expect: c.expect, passed, note });
  fs.rmSync(file, { force: true });
  fs.rmSync(path.join(REPO, "signed-tx.json"), { force: true });
}

console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
console.log("║                 OFFLINE ADVERSARIAL TEST RESULTS                     ║");
console.log("╚══════════════════════════════════════════════════════════════════════╝");
for (const r of results) {
  const mark = r.passed ? "✓" : "✗";
  console.log(`  ${mark}  ${r.name.padEnd(45)} ${r.expect.padEnd(22)} — ${r.note}`);
}
const failing = results.filter((r) => !r.passed);
console.log();
console.log(
  `RESULT: ${results.length - failing.length}/${results.length} passed` +
    (failing.length ? ` — ${failing.length} FAILED` : "")
);
process.exit(failing.length ? 1 : 0);
