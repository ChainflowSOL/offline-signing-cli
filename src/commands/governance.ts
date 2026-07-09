import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getMint,
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
import { getConnection } from "../utils/connection";
import { saveJson, serializeInstruction, VectorExecuteTxV1 } from "../utils/io";
import {
  digestExecute,
  encodeSubInstructions,
  fetchVectorAccount,
  findVaultPda,
  findVectorPda,
} from "../utils/vector";

// Small helper: the SPL Governance builders push into a Vec<Ix> and return
// PDAs/void. We only care about the ix they emitted, which is always the last
// one appended.
function takeIx(list: TransactionInstruction[]): TransactionInstruction {
  const ix = list[list.length - 1];
  if (!ix) throw new Error("SPL Governance helper produced no instruction");
  return ix;
}

async function fetchSeedAndVault(
  env: string,
  authority: PublicKey
): Promise<{ seed: Buffer; vault: PublicKey }> {
  const connection = getConnection(env);
  const acc = await fetchVectorAccount(connection, authority);
  const [vault] = findVaultPda(authority);
  return { seed: acc.seed, vault };
}

function makePayload(
  description: string,
  network: string,
  authority: PublicKey,
  feePayer: PublicKey,
  subIxs: TransactionInstruction[],
  seed: Buffer,
  meta: VectorExecuteTxV1["meta"]
): VectorExecuteTxV1 {
  const subIxData = encodeSubInstructions(subIxs);
  const digest = digestExecute(seed, subIxData);
  return {
    version: "vector-v1",
    action: "execute",
    description,
    network,
    coldAddress: authority.toBase58(),
    feePayer: feePayer.toBase58(),
    seedBase64: seed.toString("base64"),
    digestBase64: digest.toString("base64"),
    subInstructions: subIxs.map(serializeInstruction),
    meta,
  };
}

function voteFromString(s: string): Vote {
  switch (s.toLowerCase()) {
    case "yes":
      return new Vote({
        voteType: VoteKind.Approve,
        approveChoices: [
          new VoteChoice({ rank: 0, weightPercentage: 100 }),
        ],
        deny: undefined,
        veto: undefined,
      });
    case "no":
      return new Vote({
        voteType: VoteKind.Deny,
        approveChoices: undefined,
        deny: true,
        veto: undefined,
      });
    case "abstain":
      return new Vote({
        voteType: VoteKind.Abstain,
        approveChoices: undefined,
        deny: undefined,
        veto: undefined,
      });
    case "veto":
      return new Vote({
        voteType: VoteKind.Veto,
        approveChoices: undefined,
        deny: undefined,
        veto: true,
      });
    default:
      throw new Error(`Unknown vote: ${s} (expected: yes | no | abstain | veto)`);
  }
}

// ── governance-deposit ────────────────────────────────────────────────

export async function constructGovernanceDeposit(
  env: string,
  coldAddressStr: string,
  governanceProgramStr: string,
  realmStr: string,
  governingTokenMintStr: string,
  amount: number,
  payerStr: string,
  programVersion: number = PROGRAM_VERSION_V3
): Promise<void> {
  const connection = getConnection(env);
  const authority = new PublicKey(coldAddressStr);
  const governanceProgram = new PublicKey(governanceProgramStr);
  const realm = new PublicKey(realmStr);
  const mint = new PublicKey(governingTokenMintStr);
  const feePayer = new PublicKey(payerStr);
  const [vectorPda] = findVectorPda(authority);
  const [vault] = findVaultPda(authority);

  const mintInfo = await getMint(connection, mint);
  const amountRaw = new BN(Math.round(amount * Math.pow(10, mintInfo.decimals)));

  // Governance tokens live in the vault's ATA (off-curve owner).
  const sourceAta = await getAssociatedTokenAddress(mint, vault, true);

  console.log(`\nConstructing GOVERNANCE-DEPOSIT on ${env.toUpperCase()}`);
  console.log(`  Authority:      ${authority.toBase58()}`);
  console.log(`  Vector PDA:     ${vectorPda.toBase58()}  (state)`);
  console.log(`  Vault PDA:      ${vault.toBase58()}  (governing_token_owner)`);
  console.log(`  Realm:          ${realm.toBase58()}`);
  console.log(`  Token mint:     ${mint.toBase58()}`);
  console.log(`  Source ATA:     ${sourceAta.toBase58()}`);
  console.log(`  Amount:         ${amount} (raw ${amountRaw.toString()})`);
  console.log(`  Fee payer:      ${feePayer.toBase58()}`);

  const ixList: TransactionInstruction[] = [];
  await withDepositGoverningTokens(
    ixList,
    governanceProgram,
    programVersion,
    realm,
    sourceAta, // governingTokenSource
    mint,
    vault, // governingTokenOwner
    vault, // governingTokenSourceAuthority (SPL token transfer_authority) — vault is ATA owner
    feePayer,
    amountRaw,
    true // governingTokenOwnerIsSigner — vault must sign as owner
  );
  const subIxs = [takeIx(ixList)];

  const { seed } = await fetchSeedAndVault(env, authority);

  const payload = makePayload(
    `Deposit ${amount} tokens into realm ${realm.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    subIxs,
    seed,
    {
      governanceAction: "deposit",
      realm: realm.toBase58(),
      governanceProgram: governanceProgram.toBase58(),
      governingTokenMint: mint.toBase58(),
      amount,
      decimals: mintInfo.decimals,
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── governance-cast-vote ──────────────────────────────────────────────

export async function constructGovernanceCastVote(
  env: string,
  coldAddressStr: string,
  governanceProgramStr: string,
  realmStr: string,
  governanceStr: string,
  proposalStr: string,
  proposalOwnerRecordStr: string,
  governingTokenMintStr: string,
  voteStr: string,
  payerStr: string,
  programVersion: number = PROGRAM_VERSION_V3
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const governanceProgram = new PublicKey(governanceProgramStr);
  const realm = new PublicKey(realmStr);
  const governance = new PublicKey(governanceStr);
  const proposal = new PublicKey(proposalStr);
  const proposalOwnerRecord = new PublicKey(proposalOwnerRecordStr);
  const mint = new PublicKey(governingTokenMintStr);
  const feePayer = new PublicKey(payerStr);
  const [vault] = findVaultPda(authority);

  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    governanceProgram,
    realm,
    mint,
    vault
  );

  const vote = voteFromString(voteStr);

  console.log(`\nConstructing GOVERNANCE-CAST-VOTE on ${env.toUpperCase()}`);
  console.log(`  Authority:              ${authority.toBase58()}`);
  console.log(`  Vault PDA:              ${vault.toBase58()}  (governance authority)`);
  console.log(`  Realm:                  ${realm.toBase58()}`);
  console.log(`  Governance:             ${governance.toBase58()}`);
  console.log(`  Proposal:               ${proposal.toBase58()}`);
  console.log(`  Proposal owner record:  ${proposalOwnerRecord.toBase58()}`);
  console.log(`  Voter TokenOwnerRecord: ${tokenOwnerRecord.toBase58()}`);
  console.log(`  Governing token mint:   ${mint.toBase58()}`);
  console.log(`  Vote:                   ${voteStr.toUpperCase()}`);
  console.log(`  Fee payer:              ${feePayer.toBase58()}`);

  const ixList: TransactionInstruction[] = [];
  await withCastVote(
    ixList,
    governanceProgram,
    programVersion,
    realm,
    governance,
    proposal,
    proposalOwnerRecord,
    tokenOwnerRecord,
    vault, // governanceAuthority
    mint, // voteGoverningTokenMint
    vote,
    feePayer
  );
  const subIxs = [takeIx(ixList)];

  const { seed } = await fetchSeedAndVault(env, authority);

  const payload = makePayload(
    `Vote ${voteStr.toUpperCase()} on proposal ${proposal.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    subIxs,
    seed,
    {
      governanceAction: "cast-vote",
      realm: realm.toBase58(),
      governanceProgram: governanceProgram.toBase58(),
      governance: governance.toBase58(),
      proposal: proposal.toBase58(),
      governingTokenMint: mint.toBase58(),
      vote: voteStr.toLowerCase() as "yes" | "no" | "abstain" | "veto",
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── governance-relinquish-vote ────────────────────────────────────────

export async function constructGovernanceRelinquishVote(
  env: string,
  coldAddressStr: string,
  governanceProgramStr: string,
  realmStr: string,
  governanceStr: string,
  proposalStr: string,
  governingTokenMintStr: string,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const governanceProgram = new PublicKey(governanceProgramStr);
  const realm = new PublicKey(realmStr);
  const governance = new PublicKey(governanceStr);
  const proposal = new PublicKey(proposalStr);
  const mint = new PublicKey(governingTokenMintStr);
  const feePayer = new PublicKey(payerStr);
  const [vault] = findVaultPda(authority);

  const tokenOwnerRecord = await getTokenOwnerRecordAddress(
    governanceProgram,
    realm,
    mint,
    vault
  );
  const voteRecord = await getVoteRecordAddress(
    governanceProgram,
    proposal,
    tokenOwnerRecord
  );

  console.log(`\nConstructing GOVERNANCE-RELINQUISH-VOTE on ${env.toUpperCase()}`);
  console.log(`  Authority:              ${authority.toBase58()}`);
  console.log(`  Vault PDA:              ${vault.toBase58()}`);
  console.log(`  Proposal:               ${proposal.toBase58()}`);
  console.log(`  Vote record:            ${voteRecord.toBase58()}`);
  console.log(`  Fee payer:              ${feePayer.toBase58()}`);

  const ixList: TransactionInstruction[] = [];
  await withRelinquishVote(
    ixList,
    governanceProgram,
    PROGRAM_VERSION_V3,
    realm,
    governance,
    proposal,
    tokenOwnerRecord,
    mint,
    voteRecord,
    vault, // governanceAuthority — only needed if proposal is still active
    feePayer // beneficiary of rent refund
  );
  const subIxs = [takeIx(ixList)];

  const { seed } = await fetchSeedAndVault(env, authority);

  const payload = makePayload(
    `Relinquish vote on proposal ${proposal.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    subIxs,
    seed,
    {
      governanceAction: "relinquish-vote",
      realm: realm.toBase58(),
      governanceProgram: governanceProgram.toBase58(),
      governance: governance.toBase58(),
      proposal: proposal.toBase58(),
      governingTokenMint: mint.toBase58(),
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── governance-withdraw ───────────────────────────────────────────────

export async function constructGovernanceWithdraw(
  env: string,
  coldAddressStr: string,
  governanceProgramStr: string,
  realmStr: string,
  governingTokenMintStr: string,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const governanceProgram = new PublicKey(governanceProgramStr);
  const realm = new PublicKey(realmStr);
  const mint = new PublicKey(governingTokenMintStr);
  const feePayer = new PublicKey(payerStr);
  const [vault] = findVaultPda(authority);

  // Destination = vault's ATA. Withdraw returns the tokens home.
  const destAta = await getAssociatedTokenAddress(mint, vault, true);

  console.log(`\nConstructing GOVERNANCE-WITHDRAW on ${env.toUpperCase()}`);
  console.log(`  Authority:      ${authority.toBase58()}`);
  console.log(`  Vault PDA:      ${vault.toBase58()}  (governing_token_owner)`);
  console.log(`  Realm:          ${realm.toBase58()}`);
  console.log(`  Token mint:     ${mint.toBase58()}`);
  console.log(`  Destination ATA:${destAta.toBase58()}`);
  console.log(`  Fee payer:      ${feePayer.toBase58()}`);

  const ixList: TransactionInstruction[] = [];
  await withWithdrawGoverningTokens(
    ixList,
    governanceProgram,
    PROGRAM_VERSION_V3,
    realm,
    destAta, // governingTokenDestination
    mint,
    vault // governingTokenOwner
  );
  const subIxs = [takeIx(ixList)];

  const { seed } = await fetchSeedAndVault(env, authority);

  const payload = makePayload(
    `Withdraw governance tokens from realm ${realm.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    subIxs,
    seed,
    {
      governanceAction: "withdraw",
      realm: realm.toBase58(),
      governanceProgram: governanceProgram.toBase58(),
      governingTokenMint: mint.toBase58(),
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}
