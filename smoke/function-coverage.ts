// Coverage test: construct a valid unsigned-tx.json for every command in the
// CLI (bypassing RPC by injecting a synthetic seed) and verify sign.ts
//   (a) verifies the recomputed digest,
//   (b) renders a decoded, human-readable action,
//   (c) signs successfully.
//
// This exercises each command's construction path + the sign.ts + describe.ts
// integration without needing network access.

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import {
  Authorized,
  Lockup,
  PublicKey,
  StakeProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import {
  digestClose,
  digestExecute,
  encodeSubInstructions,
  findVaultPda,
} from "../src/utils/vector";
import { serializeInstruction } from "../src/utils/io";

const REPO = path.resolve(__dirname, "..");
const SCRATCH = path.resolve(__dirname);
const cold = new PublicKey("GULFyMN687tE8ZhdCSTb7tGSjSectcVUs2P7XUFjSzqb");
const hot = new PublicKey("6bZJmyGwb3i1XkhjsrkrHHqkAAB82g1AwgqM2rY2zZWF");
const alice = new PublicKey("3iAnUKLYgszyh9A3HZxnSnuhhu7kRYY7edAxTP2R9MfC");
const validator = new PublicKey("deepPy86gApSci6B3QHsncudzQBMNX8f6Wwwsz64bUz");
const usdcMint = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // arbitrary
const [vault] = findVaultPda(cold);
const seed = Buffer.alloc(32, 0xab);

async function run() {
  interface Case {
    name: string;
    buildPayload: () => Promise<object>;
    mustContainOnSign: string[];
  }

  const stakeAcct = await PublicKey.createWithSeed(
    vault,
    "coverage-1",
    StakeProgram.programId
  );

  const cases: Case[] = [
    {
      name: "F1-sol-transfer",
      buildPayload: async () => {
        const ix = SystemProgram.transfer({
          fromPubkey: vault,
          toPubkey: alice,
          lamports: 500_000,
        });
        return {
          version: "vector-v1",
          action: "execute",
          description: "Transfer 0.0005 SOL",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString(
            "base64"
          ),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            tokenSymbol: "SOL",
            decimals: 9,
            amount: 0.0005,
            recipient: alice.toBase58(),
          },
        };
      },
      mustContainOnSign: ["SOL TRANSFER 0.0005 SOL", "System Program"],
    },
    {
      name: "F2-token-transfer",
      buildPayload: async () => {
        const sourceAta = await getAssociatedTokenAddress(usdcMint, vault, true);
        const destAta = await getAssociatedTokenAddress(usdcMint, alice);
        const ix = createTransferInstruction(sourceAta, destAta, vault, 250_000n);
        return {
          version: "vector-v1",
          action: "execute",
          description: "Transfer 0.25 USDC",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString(
            "base64"
          ),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            tokenSymbol: "USDC",
            decimals: 6,
            amount: 0.25,
            recipient: alice.toBase58(),
          },
        };
      },
      mustContainOnSign: ["SPL TOKEN TRANSFER", "SPL Token Program"],
    },
    {
      name: "F3-close-authority",
      buildPayload: async () => ({
        version: "vector-v1",
        action: "close",
        description: "Close to Alice",
        network: "devnet",
        coldAddress: cold.toBase58(),
        feePayer: hot.toBase58(),
        seedBase64: seed.toString("base64"),
        digestBase64: digestClose(seed, alice).toString("base64"),
        closeTo: alice.toBase58(),
      }),
      mustContainOnSign: ["CLOSE the Vector account", "drains the ENTIRE vault"],
    },
    {
      name: "F4-stake-create",
      buildPayload: async () => {
        const createIx = SystemProgram.createAccountWithSeed({
          fromPubkey: vault,
          newAccountPubkey: stakeAcct,
          basePubkey: vault,
          seed: "coverage-1",
          lamports: 1_200_000_000,
          space: 200,
          programId: StakeProgram.programId,
        });
        const initIx = StakeProgram.initialize({
          stakePubkey: stakeAcct,
          authorized: new Authorized(vault, vault),
          lockup: new Lockup(0, 0, PublicKey.default),
        });
        const ixs = [createIx, initIx];
        return {
          version: "vector-v1",
          action: "execute",
          description: "Create stake account",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions(ixs)).toString(
            "base64"
          ),
          subInstructions: ixs.map(serializeInstruction),
          meta: {
            stakeAction: "create",
            stakePubkey: stakeAcct.toBase58(),
            stakeSeed: "coverage-1",
            amount: 1.2,
            tokenSymbol: "SOL",
            decimals: 9,
          },
        };
      },
      mustContainOnSign: ["CREATE ACCOUNT WITH SEED", "STAKE INITIALIZE"],
    },
    {
      name: "F5-stake-delegate",
      buildPayload: async () => {
        const tx = StakeProgram.delegate({
          stakePubkey: stakeAcct,
          authorizedPubkey: vault,
          votePubkey: validator,
        });
        const ix = tx.instructions[0]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Delegate stake",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString(
            "base64"
          ),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            stakeAction: "delegate",
            stakePubkey: stakeAcct.toBase58(),
            validatorVotePubkey: validator.toBase58(),
          },
        };
      },
      mustContainOnSign: ["STAKE DELEGATE"],
    },
    {
      name: "F6-stake-deactivate",
      buildPayload: async () => {
        const tx = StakeProgram.deactivate({
          stakePubkey: stakeAcct,
          authorizedPubkey: vault,
        });
        const ix = tx.instructions[0]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Deactivate stake",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString(
            "base64"
          ),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            stakeAction: "deactivate",
            stakePubkey: stakeAcct.toBase58(),
          },
        };
      },
      mustContainOnSign: ["STAKE DEACTIVATE"],
    },
    {
      name: "F7-stake-withdraw",
      buildPayload: async () => {
        const tx = StakeProgram.withdraw({
          stakePubkey: stakeAcct,
          authorizedPubkey: vault,
          toPubkey: alice,
          lamports: 1_200_000_000,
        });
        const ix = tx.instructions[0]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Withdraw stake",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString(
            "base64"
          ),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            stakeAction: "withdraw",
            stakePubkey: stakeAcct.toBase58(),
            amount: 1.2,
            recipient: alice.toBase58(),
            tokenSymbol: "SOL",
            decimals: 9,
          },
        };
      },
      mustContainOnSign: ["STAKE WITHDRAW", "withdraw 1.2 SOL"],
    },
  ];

  const results: { name: string; passed: boolean; note: string }[] = [];
  for (const c of cases) {
    const p = await c.buildPayload();
    const file = path.join(SCRATCH, `cov-${c.name}.json`);
    fs.writeFileSync(file, JSON.stringify(p, null, 2));

    let stdout = "";
    try {
      stdout = execSync(
        `echo yes | pnpm exec ts-node src/index.ts sign --keypair smoke/cold-test.json --unsigned ${file}`,
        { cwd: REPO, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }
      );
    } catch (e: any) {
      stdout = (e.stdout ?? "").toString() + (e.stderr ?? "").toString();
    }

    const signed = /Saved to.*signed-tx\.json/.test(stdout);
    const missing = c.mustContainOnSign.filter((s) => !stdout.includes(s));
    const passed = signed && missing.length === 0;
    const note = signed
      ? missing.length === 0
        ? "signed; UI showed all expected phrases"
        : `signed but UI missing: ${missing.join(", ")}`
      : "did not sign (unexpected)";
    results.push({ name: c.name, passed, note });
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(REPO, "signed-tx.json"), { force: true });
  }

  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║                 FUNCTION COVERAGE TEST RESULTS                       ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  for (const r of results) {
    const mark = r.passed ? "✓" : "✗";
    console.log(`  ${mark}  ${r.name.padEnd(30)} — ${r.note}`);
  }
  const failing = results.filter((r) => !r.passed);
  console.log();
  console.log(
    `RESULT: ${results.length - failing.length}/${results.length} passed` +
      (failing.length ? ` — ${failing.length} FAILED` : "")
  );
  process.exit(failing.length ? 1 : 0);
}

run().catch((e) => {
  console.error(e);
  process.exit(2);
});
