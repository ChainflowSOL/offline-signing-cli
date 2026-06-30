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
}

export interface VectorExecuteTxV1 {
  version: "vector-v1";
  action: "execute";
  description: string;
  network: string;
  coldAddress: string;
  feePayer: string;
  digestBase64: string;
  subInstructions: SerializedInstruction[];
  meta?: TxMeta;
}

export interface VectorCloseTxV1 {
  version: "vector-v1";
  action: "close";
  description: string;
  network: string;
  coldAddress: string;
  feePayer: string;
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
