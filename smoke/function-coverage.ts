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
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  getTokenOwnerRecordAddress,
  getVoteRecordAddress,
  PROGRAM_VERSION_V3,
  Vote,
  VoteKind,
  VoteChoice,
  withCastVote,
  withDepositGoverningTokens,
  withRelinquishVote,
  withWithdrawGoverningTokens,
} from "@solana/spl-governance";
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
      name: "F8-governance-deposit",
      buildPayload: async () => {
        const gov = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
        const realm = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // arbitrary
        const mint = new PublicKey("So11111111111111111111111111111111111111112");
        const sourceAta = await getAssociatedTokenAddress(mint, vault, true);
        const list: TransactionInstruction[] = [];
        await withDepositGoverningTokens(
          list, gov, PROGRAM_VERSION_V3, realm, sourceAta, mint,
          vault, vault, hot, new BN(1_000_000), true
        );
        const ix = list[list.length - 1]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Deposit into realm",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString("base64"),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            governanceAction: "deposit",
            realm: realm.toBase58(),
            governanceProgram: gov.toBase58(),
            governingTokenMint: mint.toBase58(),
            amount: 1,
            decimals: 6,
          },
        };
      },
      mustContainOnSign: ["GOVERNANCE DEPOSIT", "SPL Governance"],
    },
    {
      name: "F9-governance-cast-vote-yes",
      buildPayload: async () => {
        const gov = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
        const realm = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const governance = new PublicKey("So11111111111111111111111111111111111111112");
        const proposal = new PublicKey("11111111111111111111111111111111");
        const proposalOwnerRecord = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
        const mint = new PublicKey("So11111111111111111111111111111111111111112");
        const tokenOwnerRecord = await getTokenOwnerRecordAddress(gov, realm, mint, vault);
        const yesVote = new Vote({
          voteType: VoteKind.Approve,
          approveChoices: [new VoteChoice({ rank: 0, weightPercentage: 100 })],
          deny: undefined,
          veto: undefined,
        });
        const list: TransactionInstruction[] = [];
        await withCastVote(
          list, gov, PROGRAM_VERSION_V3, realm, governance, proposal,
          proposalOwnerRecord, tokenOwnerRecord, vault, mint, yesVote, hot
        );
        const ix = list[list.length - 1]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Vote yes",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString("base64"),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            governanceAction: "cast-vote",
            realm: realm.toBase58(),
            governanceProgram: gov.toBase58(),
            governance: governance.toBase58(),
            proposal: proposal.toBase58(),
            governingTokenMint: mint.toBase58(),
            vote: "yes",
          },
        };
      },
      mustContainOnSign: ["GOVERNANCE CAST VOTE: YES (Approve)"],
    },
    {
      name: "F10-governance-relinquish-vote",
      buildPayload: async () => {
        const gov = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
        const realm = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const governance = new PublicKey("So11111111111111111111111111111111111111112");
        const proposal = new PublicKey("11111111111111111111111111111111");
        const mint = new PublicKey("So11111111111111111111111111111111111111112");
        const tokenOwnerRecord = await getTokenOwnerRecordAddress(gov, realm, mint, vault);
        const voteRecord = await getVoteRecordAddress(gov, proposal, tokenOwnerRecord);
        const list: TransactionInstruction[] = [];
        await withRelinquishVote(
          list, gov, PROGRAM_VERSION_V3, realm, governance, proposal,
          tokenOwnerRecord, mint, voteRecord, vault, hot
        );
        const ix = list[list.length - 1]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Relinquish vote",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString("base64"),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            governanceAction: "relinquish-vote",
            realm: realm.toBase58(),
            governanceProgram: gov.toBase58(),
            proposal: proposal.toBase58(),
          },
        };
      },
      mustContainOnSign: ["GOVERNANCE RELINQUISH VOTE"],
    },
    {
      name: "F11-governance-withdraw",
      buildPayload: async () => {
        const gov = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
        const realm = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const mint = new PublicKey("So11111111111111111111111111111111111111112");
        const destAta = await getAssociatedTokenAddress(mint, vault, true);
        const list: TransactionInstruction[] = [];
        await withWithdrawGoverningTokens(
          list, gov, PROGRAM_VERSION_V3, realm, destAta, mint, vault
        );
        const ix = list[list.length - 1]!;
        return {
          version: "vector-v1",
          action: "execute",
          description: "Withdraw from realm",
          network: "devnet",
          coldAddress: cold.toBase58(),
          feePayer: hot.toBase58(),
          seedBase64: seed.toString("base64"),
          digestBase64: digestExecute(seed, encodeSubInstructions([ix])).toString("base64"),
          subInstructions: [ix].map(serializeInstruction),
          meta: {
            governanceAction: "withdraw",
            realm: realm.toBase58(),
            governanceProgram: gov.toBase58(),
            governingTokenMint: mint.toBase58(),
          },
        };
      },
      mustContainOnSign: ["GOVERNANCE WITHDRAW governing tokens"],
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
