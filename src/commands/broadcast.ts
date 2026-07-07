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

  // Hot-wallet-side pre-instructions: ensure destination ATAs exist for any
  // SPL token transfers. These are NOT in the signed digest — they're
  // fee-payer concerns. We pay rent and the tx still requires the cold sig.
  const preIxs: TransactionInstruction[] = [];
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
