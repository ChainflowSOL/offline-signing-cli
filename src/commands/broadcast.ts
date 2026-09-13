import {
  Connection,
  Keypair,
  MessageV0,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  getTokenOwnerRecordAddress,
  PROGRAM_VERSION_V3,
  withCreateTokenOwnerRecord,
} from "@solana/spl-governance";
import * as fs from "fs";
import nacl from "tweetnacl";
import { getConnection } from "../utils/connection";
import {
  deserializeInstruction,
  loadJson,
  SignedTxJson,
  UnsignedTxJson,
  VectorExecuteTxV1,
  VectorCloseTxV1,
} from "../utils/io";
import {
  buildCloseInstruction,
  buildEd25519PrecompileInstruction,
  buildExecuteInstruction,
  encodeSubInstructions,
  findVaultPda,
} from "../utils/vector";

function loadKeypair(p: string): Keypair {
  if (!fs.existsSync(p)) throw new Error(`Keypair file not found: ${p}`);
  return Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(p, "utf-8")))
  );
}

export async function broadcast(
  env: string,
  unsignedPath: string,
  signedPath: string,
  payerKeypairPath?: string
): Promise<void> {
  if (!payerKeypairPath) {
    throw new Error("--payer <hot-wallet.json> is required.");
  }

  const connection = getConnection(env);
  const unsigned = loadJson<UnsignedTxJson>(unsignedPath);
  const signed = loadJson<SignedTxJson>(signedPath);

  if (unsigned.version !== "vector-v1" || signed.version !== "vector-v1") {
    throw new Error("Both files must be version 'vector-v1'.");
  }
  if (unsigned.action !== signed.action) {
    throw new Error(
      `Action mismatch: unsigned=${unsigned.action}, signed=${signed.action}`
    );
  }
  if (unsigned.coldAddress !== signed.coldAddress) {
    throw new Error("coldAddress mismatch between unsigned and signed files.");
  }

  const payer = loadKeypair(payerKeypairPath);
  if (payer.publicKey.toBase58() !== unsigned.feePayer) {
    throw new Error(
      `Payer keypair (${payer.publicKey.toBase58()}) does not match feePayer ` +
        `recorded in unsigned-tx.json (${unsigned.feePayer}).`
    );
  }

  const authority = new PublicKey(unsigned.coldAddress);
  const digest = Buffer.from(unsigned.digestBase64, "base64");
  const signature = Buffer.from(signed.signatureBase64, "base64");

  // Sanity-check the signature before paying for a doomed tx.
  const sigOk = nacl.sign.detached.verify(
    digest,
    signature,
    authority.toBytes()
  );
  if (!sigOk) {
    throw new Error(
      "Signature does not verify against the digest and cold pubkey. " +
        "Refusing to broadcast."
    );
  }

  const precompileIx = buildEd25519PrecompileInstruction(
    authority.toBuffer(),
    signature,
    digest
  );

  let instructions: TransactionInstruction[];
  if (unsigned.action === "execute") {
    instructions = await buildExecuteIxs(
      connection,
      unsigned,
      authority,
      precompileIx,
      payer.publicKey
    );
  } else {
    instructions = buildCloseIxs(unsigned, authority, precompileIx);
  }

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const messageV0: MessageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message();

  const tx = new VersionedTransaction(messageV0);
  tx.sign([payer]);

  console.log(`\nBroadcasting on ${env.toUpperCase()}...`);
  console.log(`  Action: ${unsigned.action}`);
  console.log(`  Authority: ${authority.toBase58()}`);
  console.log(`  Payer:     ${payer.publicKey.toBase58()}`);

  const txid = await connection.sendTransaction(tx, {
    skipPreflight: false,
    preflightCommitment: "confirmed",
  });
  console.log(`\nSent! ${txid}`);
  console.log(`https://explorer.solana.com/tx/${txid}?cluster=${env}`);
  await connection.confirmTransaction(txid, "confirmed");
  console.log("Confirmed.");
}

async function buildExecuteIxs(
  connection: Connection,
  unsigned: VectorExecuteTxV1,
  authority: PublicKey,
  precompileIx: TransactionInstruction,
  payer: PublicKey
): Promise<TransactionInstruction[]> {
  const subIxs = unsigned.subInstructions.map(deserializeInstruction);
  const subIxData = encodeSubInstructions(subIxs);

  assertCoSignerScope(authority, subIxs, payer);

  // Hot-wallet-side pre-instructions: ensure destination ATAs exist for any
  // SPL token transfers. These are NOT in the signed digest — they're
  // fee-payer concerns. We pay rent and the tx still requires the cold sig.
  const preIxs: TransactionInstruction[] = [];

  // Same idea for SPL Governance: DepositGoverningTokens needs the voter's
  // TokenOwnerRecord to exist. Creating it costs rent and requires a payer
  // signature, so it can't live inside a Vault-PDA-signed sub-instruction —
  // we create it hot-side first instead.
  await addGovernanceTokenOwnerRecordIxs(connection, unsigned, subIxs, payer, preIxs);

  for (const sub of subIxs) {
    if (!sub.programId.equals(TOKEN_PROGRAM_ID)) continue;
    if (sub.data.length === 0 || sub.data[0] !== 3) continue; // 3 = Transfer
    if (sub.keys.length < 2) continue;
    const sourceMeta = sub.keys[0];
    const destMeta = sub.keys[1];
    if (!sourceMeta || !destMeta) continue;
    const destAta = destMeta.pubkey;
    const info = await connection.getAccountInfo(destAta);
    if (info) continue;

    // Derive the mint by inspecting the source ATA on-chain.
    const sourceAta = sourceMeta.pubkey;
    const sourceInfo = await connection.getAccountInfo(sourceAta);
    if (!sourceInfo) {
      throw new Error(
        `Source ATA ${sourceAta.toBase58()} missing — cannot infer mint for dest ATA pre-create.`
      );
    }
    // SPL Token Account layout: bytes 0..32 = mint.
    const mint = new PublicKey(sourceInfo.data.slice(0, 32));

    // The recipient (ATA owner) is NOT one of the transfer's accounts — those
    // are [source ATA, dest ATA, authority]. It only exists implicitly as
    // destAta = getAssociatedTokenAddress(mint, recipient). Recover it from the
    // (untrusted) meta.recipient and round-trip-verify the derivation, so a
    // tampered meta.recipient can only cause a clean skip, never a wrong ATA.
    const recipientStr = unsigned.meta?.recipient;
    if (!recipientStr) {
      throw new Error(
        `Destination ATA ${destAta.toBase58()} does not exist and unsigned-tx.json has no ` +
          `meta.recipient to derive its owner. Create the ATA manually first.`
      );
    }
    const recipient = new PublicKey(recipientStr);
    const derived = await getAssociatedTokenAddress(mint, recipient);
    if (!derived.equals(destAta)) {
      throw new Error(
        `Destination ATA ${destAta.toBase58()} does not match the ATA derived from ` +
          `meta.recipient (${recipient.toBase58()}). Refusing to create a mismatched ATA.`
      );
    }
    preIxs.push(
      createAssociatedTokenAccountInstruction(payer, destAta, recipient, mint)
    );
  }

  // Precompile must come BEFORE our execute ix. Index = preIxs.length.
  const ed25519Index = preIxs.length;
  const executeIx = buildExecuteInstruction(
    authority,
    ed25519Index,
    subIxData,
    subIxs
  );

  return [...preIxs, precompileIx, executeIx];
}

// Programs allowed to request a co-signer (a non-vault signer inside a
// sub-instruction). Kept deliberately tiny: only SPL Governance genuinely needs
// it, because CastVote creates the VoteRecord as part of voting and the Vault
// PDA cannot pay rent.
//
// The on-chain program would accept a co-signer for ANY program. This check is
// the client-side belt to that braces: it confines the widened signer model to
// governance, so even a cold key that has been compromised cannot use this path
// to make the hot wallet sign an arbitrary transfer of its own funds.
const CO_SIGNER_ALLOWED_PROGRAMS = new Set<string>([
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", // SPL Governance (Realms)
]);

function assertCoSignerScope(
  authority: PublicKey,
  subIxs: TransactionInstruction[],
  payer: PublicKey
): void {
  const [vault] = findVaultPda(authority);
  for (const ix of subIxs) {
    for (const k of ix.keys) {
      if (!k.isSigner || k.pubkey.equals(vault)) continue;

      if (!k.pubkey.equals(payer)) {
        throw new Error(
          `Sub-instruction requires ${k.pubkey.toBase58()} to sign, but that is ` +
            `neither the vault nor this broadcaster's fee payer. Refusing to broadcast.`
        );
      }
      if (!CO_SIGNER_ALLOWED_PROGRAMS.has(ix.programId.toBase58())) {
        throw new Error(
          `Sub-instruction for program ${ix.programId.toBase58()} asks the fee payer ` +
            `(${payer.toBase58()}) to co-sign. Only SPL Governance may do this, because ` +
            `its CastVote creates the vote record. Refusing to broadcast — this would ` +
            `let the signed action debit your hot wallet.`
        );
      }
    }
  }
}

// SPL Governance DepositGoverningTokens account layout:
//   0 realm, 1 holding, 2 source, 3 owner, 4 source_authority,
//   5 token_owner_record, 6 payer, 7 system, 8 spl_token, 9 realm_config
const GOV_DEPOSIT_DISCRIMINATOR = 1;
const GOV_TOR_ACCOUNT_INDEX = 5;
const GOV_OWNER_ACCOUNT_INDEX = 3;

async function addGovernanceTokenOwnerRecordIxs(
  connection: Connection,
  unsigned: VectorExecuteTxV1,
  subIxs: TransactionInstruction[],
  payer: PublicKey,
  preIxs: TransactionInstruction[]
): Promise<void> {
  const govProgramStr = unsigned.meta?.governanceProgram;
  const realmStr = unsigned.meta?.realm;
  const mintStr = unsigned.meta?.governingTokenMint;
  if (!govProgramStr || !realmStr || !mintStr) return;

  const govProgram = new PublicKey(govProgramStr);
  const realm = new PublicKey(realmStr);
  const mint = new PublicKey(mintStr);

  for (const sub of subIxs) {
    if (!sub.programId.equals(govProgram)) continue;
    if (sub.data.length === 0 || sub.data[0] !== GOV_DEPOSIT_DISCRIMINATOR) continue;
    if (sub.keys.length <= GOV_TOR_ACCOUNT_INDEX) continue;

    const torMeta = sub.keys[GOV_TOR_ACCOUNT_INDEX];
    const ownerMeta = sub.keys[GOV_OWNER_ACCOUNT_INDEX];
    if (!torMeta || !ownerMeta) continue;

    const info = await connection.getAccountInfo(torMeta.pubkey);
    if (info) continue; // already exists — nothing to do

    // meta.* is untrusted, so round-trip-verify: the record we're about to
    // create must derive to exactly the address the signed sub-instruction
    // names. A tampered meta can then only cause a clean failure, never a
    // record created against a realm/mint the cold wallet didn't authorize.
    const derived = await getTokenOwnerRecordAddress(
      govProgram,
      realm,
      mint,
      ownerMeta.pubkey
    );
    if (!derived.equals(torMeta.pubkey)) {
      throw new Error(
        `TokenOwnerRecord ${torMeta.pubkey.toBase58()} does not match the address ` +
          `derived from meta (realm=${realm.toBase58()}, mint=${mint.toBase58()}). ` +
          `Refusing to create a mismatched record.`
      );
    }

    await withCreateTokenOwnerRecord(
      preIxs,
      govProgram,
      PROGRAM_VERSION_V3,
      realm,
      ownerMeta.pubkey,
      mint,
      payer
    );
  }
}

function buildCloseIxs(
  unsigned: VectorCloseTxV1,
  authority: PublicKey,
  precompileIx: TransactionInstruction
): TransactionInstruction[] {
  const closeTo = new PublicKey(unsigned.closeTo);
  // ed25519 ix is at index 0; close ix is at index 1.
  const closeIx = buildCloseInstruction(authority, closeTo, 0);
  return [precompileIx, closeIx];
}
