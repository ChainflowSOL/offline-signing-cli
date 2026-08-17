// Devnet setup for the governance test.
//
// Creates a real SPL Governance realm + governance + community mint, gives the
// HOT wallet voting weight (so it can create the proposal with plain txs), and
// mints community tokens into the VAULT's ATA so the offline-signing CLI can
// deposit / vote / relinquish / withdraw through the Vector program.
//
// Only the 4 governance-* CLI commands go through the offline flow; all setup
// here is ordinary hot-wallet signing.
//
// Usage: pnpm exec ts-node smoke/setup-realm.ts <COLD_PUBKEY>

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import {
  getTokenOwnerRecordAddress,
  GovernanceConfig,
  MintMaxVoteWeightSource,
  PROGRAM_VERSION_V3,
  VoteThreshold,
  VoteThresholdType,
  VoteTipping,
  withCreateGovernance,
  withCreateRealm,
  withDepositGoverningTokens,
} from "@solana/spl-governance";
import * as fs from "fs";
import { findVaultPda } from "../src/utils/vector";

const GOV = new PublicKey("GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw");
const RPC = "https://api.devnet.solana.com";

async function send(
  conn: Connection,
  ixs: TransactionInstruction[],
  payer: Keypair,
  extra: Keypair[] = []
): Promise<string> {
  const tx = new Transaction().add(...ixs);
  return sendAndConfirmTransaction(conn, tx, [payer, ...extra], {
    commitment: "confirmed",
  });
}

async function main() {
  const coldStr = process.argv[2];
  if (!coldStr) throw new Error("usage: setup-realm.ts <COLD_PUBKEY>");
  const cold = new PublicKey(coldStr);
  const [vault] = findVaultPda(cold);

  const conn = new Connection(RPC, "confirmed");
  const payer = Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))
    )
  );

  // ── 1. community mint ────────────────────────────────────────────
  const mintKp = Keypair.generate();
  const rent = await getMinimumBalanceForRentExemptMint(conn);
  const hotAta = await getAssociatedTokenAddress(mintKp.publicKey, payer.publicKey);
  const vaultAta = await getAssociatedTokenAddress(mintKp.publicKey, vault, true);

  await send(
    conn,
    [
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports: rent,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(mintKp.publicKey, 6, payer.publicKey, null),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        hotAta,
        payer.publicKey,
        mintKp.publicKey
      ),
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vaultAta,
        vault,
        mintKp.publicKey
      ),
      // hot wallet gets weight so it can create the governance + proposal
      createMintToInstruction(mintKp.publicKey, hotAta, payer.publicKey, 1_000_000_000),
      // vault gets tokens to deposit through the offline flow
      createMintToInstruction(mintKp.publicKey, vaultAta, payer.publicKey, 500_000_000),
    ],
    payer,
    [mintKp]
  );
  console.log("MINT=" + mintKp.publicKey.toBase58());

  // ── 2. realm ─────────────────────────────────────────────────────
  const name = "vector-test-" + Date.now().toString().slice(-6);
  let ixs: TransactionInstruction[] = [];
  const realm = await withCreateRealm(
    ixs,
    GOV,
    PROGRAM_VERSION_V3,
    name,
    payer.publicKey, // realm authority
    mintKp.publicKey, // community mint
    payer.publicKey, // payer
    undefined, // no council mint
    MintMaxVoteWeightSource.FULL_SUPPLY_FRACTION,
    new BN(1), // min community weight to create governance
    undefined,
    undefined
  );
  await send(conn, ixs, payer);
  console.log("REALM=" + realm.toBase58());

  // ── 3. hot wallet deposits so it has voting weight ───────────────
  ixs = [];
  await withDepositGoverningTokens(
    ixs,
    GOV,
    PROGRAM_VERSION_V3,
    realm,
    hotAta,
    mintKp.publicKey,
    payer.publicKey,
    payer.publicKey,
    payer.publicKey,
    new BN(1_000_000_000),
    true
  );
  await send(conn, ixs, payer);

  const hotTor = await getTokenOwnerRecordAddress(
    GOV,
    realm,
    mintKp.publicKey,
    payer.publicKey
  );
  console.log("HOT_TOKEN_OWNER_RECORD=" + hotTor.toBase58());

  // ── 4. governance ────────────────────────────────────────────────
  const config = new GovernanceConfig({
    communityVoteThreshold: new VoteThreshold({
      type: VoteThresholdType.YesVotePercentage,
      value: 60,
    }),
    minCommunityTokensToCreateProposal: new BN(1),
    minInstructionHoldUpTime: 0,
    baseVotingTime: 3600, // 1 hour voting window
    communityVoteTipping: VoteTipping.Disabled, // don't auto-finalize on our vote
    minCouncilTokensToCreateProposal: new BN(1),
    councilVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled }),
    councilVetoVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled }),
    communityVetoVoteThreshold: new VoteThreshold({ type: VoteThresholdType.Disabled }),
    councilVoteTipping: VoteTipping.Disabled,
    votingCoolOffTime: 0,
    depositExemptProposalCount: 10,
  });

  ixs = [];
  const governance = await withCreateGovernance(
    ixs,
    GOV,
    PROGRAM_VERSION_V3,
    realm,
    undefined, // governedAccount — none, generic governance
    config,
    hotTor,
    payer.publicKey,
    payer.publicKey
  );
  await send(conn, ixs, payer);
  console.log("GOVERNANCE=" + governance.toBase58());

  fs.writeFileSync(
    "smoke/.realm-info.json",
    JSON.stringify(
      {
        governanceProgram: GOV.toBase58(),
        realm: realm.toBase58(),
        governance: governance.toBase58(),
        mint: mintKp.publicKey.toBase58(),
        hotTokenOwnerRecord: hotTor.toBase58(),
        vaultAta: vaultAta.toBase58(),
        cold: cold.toBase58(),
        vault: vault.toBase58(),
      },
      null,
      2
    )
  );
  console.log("\nwrote smoke/.realm-info.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
