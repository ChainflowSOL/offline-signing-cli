import {
  LAMPORTS_PER_SOL,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Human-readable rendering of sub-instructions for the OFFLINE signer.
//
// SECURITY: every line here is derived from the raw instruction bytes/accounts,
// which are bound into the signed digest. The signer verifies the digest first,
// so whatever these functions show is provably exactly what will execute
// on-chain. Recognized instructions get a friendly summary; anything else is
// dumped in full (program id + every account + raw data) so a sub-instruction
// can never be silently hidden behind a benign-looking label.

const KNOWN_PROGRAMS: Record<string, string> = {
  [SystemProgram.programId.toBase58()]: "System Program",
  [StakeProgram.programId.toBase58()]: "Stake Program",
  [TOKEN_PROGRAM_ID.toBase58()]: "SPL Token Program",
};

const STAKE_OPS: Record<number, string> = {
  0: "INITIALIZE",
  1: "AUTHORIZE",
  2: "DELEGATE",
  3: "SPLIT",
  4: "WITHDRAW",
  5: "DEACTIVATE",
  6: "SET_LOCKUP",
};

function solStr(lamports: bigint): string {
  return `${Number(lamports) / LAMPORTS_PER_SOL} SOL (${lamports.toString()} lamports)`;
}

function acct(ix: TransactionInstruction, i: number): string {
  return ix.keys[i]?.pubkey.toBase58() ?? "<missing account>";
}

function rawDump(ix: TransactionInstruction, data: Buffer): string[] {
  const lines = ["        -> UNRECOGNIZED INSTRUCTION - review the raw details below carefully:"];
  ix.keys.forEach((k, i) => {
    const flags = `${k.isWritable ? " (writable)" : ""}${k.isSigner ? " (signer)" : ""}`;
    lines.push(`          acct[${i}] ${k.pubkey.toBase58()}${flags}`);
  });
  lines.push(`          data (${data.length} bytes, hex): ${data.toString("hex") || "<empty>"}`);
  return lines;
}

export function describeSubInstruction(
  ix: TransactionInstruction,
  index: number
): string[] {
  const pid = ix.programId.toBase58();
  const name = KNOWN_PROGRAMS[pid] ?? "UNKNOWN PROGRAM";
  const lines = [`  [${index}] ${name} (${pid})`];
  const data = Buffer.from(ix.data);

  try {
    if (ix.programId.equals(SystemProgram.programId)) {
      const kind = data.readUInt32LE(0);
      if (kind === 2 && data.length >= 12) {
        // Transfer { lamports: u64 }
        lines.push(`        -> SOL TRANSFER ${solStr(data.readBigUInt64LE(4))}`);
        lines.push(`           from ${acct(ix, 0)}`);
        lines.push(`           to   ${acct(ix, 1)}`);
        return lines;
      }
      if (kind === 3) {
        // CreateAccountWithSeed — accounts: [from, created, (base)]
        lines.push(`        -> CREATE ACCOUNT WITH SEED`);
        lines.push(`           funder  ${acct(ix, 0)}`);
        lines.push(`           created ${acct(ix, 1)}`);
        return lines;
      }
    }

    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (data[0] === 3 && data.length >= 9) {
        // Transfer { amount: u64 } (raw base units — decimals not known offline)
        lines.push(`        -> SPL TOKEN TRANSFER amount ${data.readBigUInt64LE(1).toString()} (raw base units)`);
        lines.push(`           source ATA ${acct(ix, 0)}`);
        lines.push(`           dest ATA   ${acct(ix, 1)}`);
        lines.push(`           authority  ${acct(ix, 2)}`);
        return lines;
      }
    }

    if (ix.programId.equals(StakeProgram.programId)) {
      const kind = data.readUInt32LE(0);
      lines.push(`        -> STAKE ${STAKE_OPS[kind] ?? `op#${kind}`}`);
      if (kind === 4 && data.length >= 12) {
        lines.push(`           withdraw ${solStr(data.readBigUInt64LE(4))}`);
      }
      ix.keys.forEach((k) => {
        const flags = `${k.isWritable ? " (w)" : ""}${k.isSigner ? " (s)" : ""}`;
        lines.push(`           acct ${k.pubkey.toBase58()}${flags}`);
      });
      return lines;
    }
  } catch {
    // Malformed / shorter than expected — fall through to the raw dump so we
    // never show a misleading partial summary.
  }

  lines.push(...rawDump(ix, data));
  return lines;
}

export function describeSubInstructions(
  ixs: TransactionInstruction[]
): string[] {
  const out: string[] = [];
  ixs.forEach((ix, i) => out.push(...describeSubInstruction(ix, i)));
  return out;
}
