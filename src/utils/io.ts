import * as fs from "fs";
import * as path from "path";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";

export interface SerializedAccountMeta {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface SerializedInstruction {
  programId: string;
  keys: SerializedAccountMeta[];
  dataBase64: string;
}

export function serializeInstruction(
  ix: TransactionInstruction
): SerializedInstruction {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    dataBase64: Buffer.from(ix.data).toString("base64"),
  };
}

export function deserializeInstruction(
  s: SerializedInstruction
): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(s.programId),
    keys: s.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(s.dataBase64, "base64"),
  });
}

export interface TxMeta {
  tokenSymbol?: string;
  decimals?: number;
  amount?: number;
  recipient?: string;
  // Stake-specific (only set on stake-* commands).
  stakeAction?: "create" | "delegate" | "deactivate" | "withdraw";
  stakePubkey?: string;
  validatorVotePubkey?: string;
  stakeSeed?: string;
  // Governance-specific (only set on governance-* commands).
  governanceAction?: "deposit" | "cast-vote" | "relinquish-vote" | "withdraw";
  realm?: string;
  governanceProgram?: string;
  proposal?: string;
  governance?: string;
  governingTokenMint?: string;
  vote?: "yes" | "no" | "abstain" | "veto";
}

export interface VectorExecuteTxV1 {
  version: "vector-v1";
  action: "execute";
  description: string;
  network: string;
  coldAddress: string;
  feePayer: string;
  // Public on-chain hashchain seed the digest was computed against. Included
  // so the OFFLINE signer can independently recompute and verify the digest
  // from `subInstructions` — the signer never has network access.
  seedBase64: string;
  digestBase64: string;
  subInstructions: SerializedInstruction[];
  // Advisory only. The signer does NOT trust `meta`; it renders the action it
  // is about to sign by decoding `subInstructions` (which are digest-bound).
  meta?: TxMeta;
}

export interface VectorCloseTxV1 {
  version: "vector-v1";
  action: "close";
  description: string;
  network: string;
  coldAddress: string;
  feePayer: string;
  // See VectorExecuteTxV1.seedBase64.
  seedBase64: string;
  digestBase64: string;
  closeTo: string;
}

export type UnsignedTxJson = VectorExecuteTxV1 | VectorCloseTxV1;

export interface SignedTxJson {
  version: "vector-v1";
  action: "execute" | "close";
  coldAddress: string;
  signatureBase64: string;
}

export const saveJson = (filename: string, data: unknown): void => {
  const filePath = path.resolve(filename);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log(`\nSaved to: ${filePath}`);
};

export const loadJson = <T>(filename: string): T => {
  if (!fs.existsSync(filename)) {
    throw new Error(`File not found: ${filename}`);
  }
  return JSON.parse(fs.readFileSync(filename, "utf-8")) as T;
};
