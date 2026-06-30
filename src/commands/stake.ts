import {
  Authorized,
  Lockup,
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "../utils/connection";
import { saveJson, serializeInstruction, VectorExecuteTxV1 } from "../utils/io";
import {
  digestExecute,
  encodeSubInstructions,
  fetchVectorAccount,
  findVaultPda,
  findVectorPda,
} from "../utils/vector";

// Solana's stake account state takes 200 bytes (v3 layout). Keep this here
// instead of using StakeProgram.space so we don't depend on a particular
// web3.js minor revision exposing that constant.
const STAKE_ACCOUNT_SPACE = 200;

// Derive the stake account address from the vault + a user-chosen seed.
// `createWithSeed` is deterministic, so the same seed string always produces
// the same stake address — convenient for institutional accounting.
async function deriveStakeAddress(
  vault: PublicKey,
  seed: string
): Promise<PublicKey> {
  return PublicKey.createWithSeed(vault, seed, StakeProgram.programId);
}

async function fetchSeed(
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
    digestBase64: digest.toString("base64"),
    subInstructions: subIxs.map(serializeInstruction),
    meta,
  };
}

// ── stake-create ──────────────────────────────────────────────────────
//
// Creates a fresh stake account derived from the Vault PDA via
// `createAccountWithSeed`. Both `from` and `base` of that ix are the Vault
// PDA, so the Vault funds the rent + stake amount in one shot. Initialize
// then sets stake & withdraw authorities to the Vault PDA, putting all
// future operations behind the offline-signing flow.

export async function constructStakeCreate(
  env: string,
  coldAddressStr: string,
  seedStr: string,
  amountSol: number,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const feePayer = new PublicKey(payerStr);
  const [vectorPda] = findVectorPda(authority);

  const { seed, vault } = await fetchSeed(env, authority);
  const stakePubkey = await deriveStakeAddress(vault, seedStr);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  console.log(`\nConstructing STAKE-CREATE on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vector PDA:   ${vectorPda.toBase58()}  (state)`);
  console.log(`  Vault PDA:    ${vault.toBase58()}  (funder + authority)`);
  console.log(`  Stake seed:   "${seedStr}"`);
  console.log(`  Stake addr:   ${stakePubkey.toBase58()}`);
  console.log(`  Amount:       ${amountSol} SOL`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);

  // createAccountWithSeed: from = base = vault, programId = StakeProgram.
  const createIx = SystemProgram.createAccountWithSeed({
    fromPubkey: vault,
    newAccountPubkey: stakePubkey,
    basePubkey: vault,
    seed: seedStr,
    lamports,
    space: STAKE_ACCOUNT_SPACE,
    programId: StakeProgram.programId,
  });

  // initialize: set both authorities to Vault PDA. No lockup.
  // Note: StakeProgram.initialize is the odd one out in web3.js v1 — returns
  // a TransactionInstruction directly, not a Transaction.
  const initIx = StakeProgram.initialize({
    stakePubkey,
    authorized: new Authorized(vault, vault),
    lockup: new Lockup(0, 0, PublicKey.default),
  });

  const payload = makePayload(
    `Create stake account ${stakePubkey.toBase58().slice(0, 8)}... with ${amountSol} SOL`,
    env,
    authority,
    feePayer,
    [createIx, initIx],
    seed,
    {
      stakeAction: "create",
      stakePubkey: stakePubkey.toBase58(),
      stakeSeed: seedStr,
      amount: amountSol,
      tokenSymbol: "SOL",
      decimals: 9,
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── stake-delegate ────────────────────────────────────────────────────

export async function constructStakeDelegate(
  env: string,
  coldAddressStr: string,
  stakePubkeyStr: string,
  votePubkeyStr: string,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const stakePubkey = new PublicKey(stakePubkeyStr);
  const votePubkey = new PublicKey(votePubkeyStr);
  const feePayer = new PublicKey(payerStr);

  const { seed, vault } = await fetchSeed(env, authority);

  console.log(`\nConstructing STAKE-DELEGATE on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vault PDA:    ${vault.toBase58()}  (stake authority)`);
  console.log(`  Stake addr:   ${stakePubkey.toBase58()}`);
  console.log(`  Validator:    ${votePubkey.toBase58()}`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);

  const tx = StakeProgram.delegate({
    stakePubkey,
    authorizedPubkey: vault,
    votePubkey,
  });
  const ix = tx.instructions[0];
  if (!ix) {
    throw new Error("StakeProgram.delegate returned no instruction");
  }

  const payload = makePayload(
    `Delegate ${stakePubkey.toBase58().slice(0, 8)}... → ${votePubkey.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    [ix],
    seed,
    {
      stakeAction: "delegate",
      stakePubkey: stakePubkey.toBase58(),
      validatorVotePubkey: votePubkey.toBase58(),
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── stake-deactivate ──────────────────────────────────────────────────

export async function constructStakeDeactivate(
  env: string,
  coldAddressStr: string,
  stakePubkeyStr: string,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const stakePubkey = new PublicKey(stakePubkeyStr);
  const feePayer = new PublicKey(payerStr);

  const { seed, vault } = await fetchSeed(env, authority);

  console.log(`\nConstructing STAKE-DEACTIVATE on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vault PDA:    ${vault.toBase58()}  (stake authority)`);
  console.log(`  Stake addr:   ${stakePubkey.toBase58()}`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);

  const tx = StakeProgram.deactivate({
    stakePubkey,
    authorizedPubkey: vault,
  });
  const ix = tx.instructions[0];
  if (!ix) {
    throw new Error("StakeProgram.deactivate returned no instruction");
  }

  const payload = makePayload(
    `Deactivate stake ${stakePubkey.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,
    [ix],
    seed,
    {
      stakeAction: "deactivate",
      stakePubkey: stakePubkey.toBase58(),
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}

// ── stake-withdraw ────────────────────────────────────────────────────

export async function constructStakeWithdraw(
  env: string,
  coldAddressStr: string,
  stakePubkeyStr: string,
  amountSol: number,
  recipientStr: string,
  payerStr: string
): Promise<void> {
  const authority = new PublicKey(coldAddressStr);
  const stakePubkey = new PublicKey(stakePubkeyStr);
  const recipient = new PublicKey(recipientStr);
  const feePayer = new PublicKey(payerStr);
  const lamports = Math.round(amountSol * LAMPORTS_PER_SOL);

  const { seed, vault } = await fetchSeed(env, authority);

  console.log(`\nConstructing STAKE-WITHDRAW on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vault PDA:    ${vault.toBase58()}  (withdraw authority)`);
  console.log(`  Stake addr:   ${stakePubkey.toBase58()}`);
  console.log(`  Amount:       ${amountSol} SOL`);
  console.log(`  Recipient:    ${recipient.toBase58()}`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);

  const tx = StakeProgram.withdraw({
    stakePubkey,
    authorizedPubkey: vault,
    toPubkey: recipient,
    lamports,
  });
  const ix = tx.instructions[0];
  if (!ix) {
    throw new Error("StakeProgram.withdraw returned no instruction");
  }

  const payload = makePayload(
    `Withdraw ${amountSol} SOL from stake ${stakePubkey.toBase58().slice(0, 8)}... → ${recipient.toBase58().slice(0, 8)}...`,
    env,
    authority,
    feePayer,

    [ix],
    seed,
    {
      stakeAction: "withdraw",
      stakePubkey: stakePubkey.toBase58(),
      amount: amountSol,
      recipient: recipient.toBase58(),
      tokenSymbol: "SOL",
      decimals: 9,
    }
  );

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to OFFLINE and run 'sign'.`);
}
