import {
  Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { createHash } from "crypto";

// ── Program constants ────────────────────────────────────────────────

// Mainnet program ID. Devnet deployment is at
// DkKZTgUDgkqUu5tck69uQJKf1deNzSY7YcU8F47oLXPZ — kept separate so signatures
// from one deployment cannot replay against the other (F5 also enforces this
// on chain by binding program ID into the digest).
export const VECTOR_PROGRAM_ID = new PublicKey(
  "FkCL7nUJym3Yc9PVgr7TQ3TRn5uJApu7FdGSV1X6rKVd"
);

export const VECTOR_PDA_SEED = Buffer.from("vector");
export const VAULT_PDA_SEED = Buffer.from("vault");

// Anchor instruction discriminators (= sha256("global:<method>")[..8]).
// Copied from target/idl/vector.json so the CLI has no Anchor runtime dep.
export const INITIALIZE_DISCRIMINATOR = Buffer.from([
  175, 175, 109, 31, 13, 152, 155, 237,
]);
export const EXECUTE_DISCRIMINATOR = Buffer.from([
  130, 221, 242, 154, 13, 193, 189, 29,
]);
export const CLOSE_DISCRIMINATOR = Buffer.from([
  98, 165, 201, 177, 108, 65, 206, 96,
]);

// Account discriminator (= sha256("account:VectorAccount")[..8]).
export const VECTOR_ACCOUNT_DISCRIMINATOR = Buffer.from([
  84, 51, 249, 250, 233, 96, 111, 40,
]);

// Domain separation tags (must match programs/vector/src/lib.rs).
export const ACTION_EXECUTE = 0x00;
export const ACTION_CLOSE = 0x01;

// ── SHA-256 helper ──────────────────────────────────────────────────

export function sha256(...parts: (Buffer | Uint8Array)[]): Buffer {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return h.digest();
}

// ── PDA ─────────────────────────────────────────────────────────────

export function findVectorPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VECTOR_PDA_SEED, authority.toBytes()],
    VECTOR_PROGRAM_ID
  );
}

// System-owned PDA that holds SOL + is the owner of SPL token ATAs.
// Separated from the state PDA because SystemProgram.transfer rejects a
// `from` account that carries data.
export function findVaultPda(authority: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [VAULT_PDA_SEED, authority.toBytes()],
    VECTOR_PROGRAM_ID
  );
}

// ── Account ─────────────────────────────────────────────────────────

export interface VectorAccount {
  authority: PublicKey;
  seed: Buffer; // 32 bytes
  bump: number;
  vaultBump: number;
}

export function deserializeVectorAccount(data: Buffer): VectorAccount {
  // Layout: [8 disc][32 authority][32 seed][1 bump][1 vault_bump]
  if (data.length < 8 + 32 + 32 + 1 + 1) {
    throw new Error(`Vector account data too short: ${data.length}`);
  }
  if (!data.subarray(0, 8).equals(VECTOR_ACCOUNT_DISCRIMINATOR)) {
    throw new Error(
      "Account discriminator does not match VectorAccount. Wrong program or wrong account?"
    );
  }
  const bump = data[72];
  const vaultBump = data[73];
  if (bump === undefined || vaultBump === undefined) {
    throw new Error("VectorAccount data missing bump bytes");
  }
  return {
    authority: new PublicKey(data.subarray(8, 40)),
    seed: Buffer.from(data.subarray(40, 72)),
    bump,
    vaultBump,
  };
}

export async function fetchVectorAccount(
  connection: Connection,
  authority: PublicKey
): Promise<VectorAccount> {
  const [pda] = findVectorPda(authority);
  const info = await connection.getAccountInfo(pda);
  if (!info) {
    throw new Error(
      `Vector PDA not found at ${pda.toBase58()} for authority ${authority.toBase58()}. ` +
        `Run 'init-authority' first.`
    );
  }
  return deserializeVectorAccount(info.data as Buffer);
}

// ── Sub-instruction wire format ─────────────────────────────────────
//
// [u8 num_ixs]
// per ix:
//   [Pubkey program_id (32B)]
//   [u8 num_accounts]
//   per account:
//     [Pubkey (32B)]
//     [u8 flags]   bit0 = is_writable, bit1 = is_signer
//   [u16 LE data_len]
//   [data]

export function encodeSubInstructions(
  ixs: TransactionInstruction[]
): Buffer {
  if (ixs.length > 255) {
    throw new Error(`Too many sub-instructions: ${ixs.length} (max 255)`);
  }

  let size = 1;
  for (const ix of ixs) {
    if (ix.keys.length > 255) {
      throw new Error(
        `Sub-instruction has too many accounts: ${ix.keys.length} (max 255)`
      );
    }
    if (ix.data.length > 0xffff) {
      throw new Error(
        `Sub-instruction data too large: ${ix.data.length} (max 65535)`
      );
    }
    size += 32 + 1 + 33 * ix.keys.length + 2 + ix.data.length;
  }

  const out = Buffer.alloc(size);
  let off = 0;

  out.writeUInt8(ixs.length, off);
  off += 1;

  for (const ix of ixs) {
    ix.programId.toBuffer().copy(out, off);
    off += 32;
    out.writeUInt8(ix.keys.length, off);
    off += 1;
    for (const meta of ix.keys) {
      meta.pubkey.toBuffer().copy(out, off);
      off += 32;
      let flags = 0;
      if (meta.isWritable) flags |= 0x01;
      if (meta.isSigner) flags |= 0x02;
      out.writeUInt8(flags, off);
      off += 1;
    }
    out.writeUInt16LE(ix.data.length, off);
    off += 2;
    Buffer.from(ix.data).copy(out, off);
    off += ix.data.length;
  }

  return out;
}

// ── Digest computation ──────────────────────────────────────────────

// Program ID is bound into every digest so a signature valid at one deployed
// program cannot be replayed against a differently-deployed one (audit F5).
// Must match the on-chain formula in execute.rs and close.rs exactly.
export function digestExecute(seed: Buffer, subIxData: Buffer): Buffer {
  return sha256(
    seed,
    Buffer.from([ACTION_EXECUTE]),
    VECTOR_PROGRAM_ID.toBuffer(),
    subIxData
  );
}

export function digestClose(seed: Buffer, closeTo: PublicKey): Buffer {
  return sha256(
    seed,
    Buffer.from([ACTION_CLOSE]),
    VECTOR_PROGRAM_ID.toBuffer(),
    closeTo.toBuffer()
  );
}

// ── Instruction builders ────────────────────────────────────────────

export function buildInitializeInstruction(
  payer: PublicKey,
  authority: PublicKey
): TransactionInstruction {
  const [vectorPda] = findVectorPda(authority);
  const [vaultPda] = findVaultPda(authority);
  return new TransactionInstruction({
    programId: VECTOR_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: false },
      { pubkey: vectorPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: INITIALIZE_DISCRIMINATOR,
  });
}

// Any sub-instruction signer that isn't the Vault PDA must be supplied as the
// program's optional `co_signer` account and sign the transaction for real.
// Returns the single such pubkey, or null when the vault-only rule applies.
export function findCoSigner(
  authority: PublicKey,
  subIxs: TransactionInstruction[]
): PublicKey | null {
  const [vaultPda] = findVaultPda(authority);
  const extra = new Set<string>();
  for (const ix of subIxs) {
    for (const meta of ix.keys) {
      if (meta.isSigner && !meta.pubkey.equals(vaultPda)) {
        extra.add(meta.pubkey.toBase58());
      }
    }
  }
  if (extra.size === 0) return null;
  if (extra.size > 1) {
    throw new Error(
      `Sub-instructions request ${extra.size} non-vault signers ` +
        `(${[...extra].join(", ")}); the program supports at most one co-signer.`
    );
  }
  return new PublicKey([...extra][0]!);
}

export function buildExecuteInstruction(
  authority: PublicKey,
  ed25519IxIndex: number,
  subIxData: Buffer,
  subIxs: TransactionInstruction[]
): TransactionInstruction {
  const [vectorPda] = findVectorPda(authority);
  const coSigner = findCoSigner(authority, subIxs);

  // remaining_accounts layout (matches Rust execute_sub_instructions walk):
  //   for each sub-ix:
  //     [program_id]
  //     [each account in sub-ix order]
  const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
  for (const ix of subIxs) {
    remaining.push({ pubkey: ix.programId, isSigner: false, isWritable: false });
    for (const meta of ix.keys) {
      // The Vault PDA's signature comes from invoke_signed inside the program,
      // so it must NOT be marked a signer at the tx level (a PDA cannot sign a
      // transaction). A co-signer, by contrast, does sign the tx for real.
      remaining.push({
        pubkey: meta.pubkey,
        isSigner: coSigner !== null && meta.pubkey.equals(coSigner),
        isWritable: meta.isWritable,
      });
    }
  }

  // [8 disc][1 ed25519_ix_index][4 LE byte vec len][sub_ix_data]
  const data = Buffer.alloc(8 + 1 + 4 + subIxData.length);
  let off = 0;
  EXECUTE_DISCRIMINATOR.copy(data, off);
  off += 8;
  data.writeUInt8(ed25519IxIndex, off);
  off += 1;
  data.writeUInt32LE(subIxData.length, off);
  off += 4;
  subIxData.copy(data, off);

  return new TransactionInstruction({
    programId: VECTOR_PROGRAM_ID,
    keys: [
      { pubkey: vectorPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      // Anchor represents an absent optional account as the program ID itself.
      coSigner
        ? { pubkey: coSigner, isSigner: true, isWritable: true }
        : { pubkey: VECTOR_PROGRAM_ID, isSigner: false, isWritable: false },
      ...remaining,
    ],
    data,
  });
}

export function buildCloseInstruction(
  authority: PublicKey,
  closeTo: PublicKey,
  ed25519IxIndex: number
): TransactionInstruction {
  const [vectorPda] = findVectorPda(authority);
  const [vaultPda] = findVaultPda(authority);
  const data = Buffer.alloc(8 + 1);
  CLOSE_DISCRIMINATOR.copy(data, 0);
  data.writeUInt8(ed25519IxIndex, 8);
  return new TransactionInstruction({
    programId: VECTOR_PROGRAM_ID,
    keys: [
      { pubkey: vectorPda, isSigner: false, isWritable: true },
      { pubkey: vaultPda, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: closeTo, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ── Ed25519 precompile builder ──────────────────────────────────────

export function buildEd25519PrecompileInstruction(
  publicKey: Buffer,
  signature: Buffer,
  message: Buffer
): TransactionInstruction {
  if (publicKey.length !== 32) throw new Error("publicKey must be 32 bytes");
  if (signature.length !== 64) throw new Error("signature must be 64 bytes");
  // Our on-chain program requires the message to be exactly the 32-byte digest.
  if (message.length !== 32) throw new Error("message must be 32 bytes");

  // @solana/web3.js ships a helper that produces the right precompile data
  // layout (num_sigs=1, all offsets self-referential, etc.). We use it to
  // avoid hand-rolling and to stay forward-compatible with the precompile.
  return Ed25519Program.createInstructionWithPublicKey({
    publicKey,
    signature,
    message,
  });
}
