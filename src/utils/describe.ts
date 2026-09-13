import {
  LAMPORTS_PER_SOL,
  PublicKey,
  StakeProgram,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// SPL Governance canonical program IDs. A DAO can theoretically deploy its own
// instance under a different program ID; only these hardcoded ones get the
// friendly clear-signing decode. Anything else falls to the raw dump — safe
// but less readable. Add IDs here when we onboard new DAOs.
const GOVERNANCE_PROGRAM_IDS = new Set<string>([
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw", // Realms / canonical SPL Governance
]);

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
  "GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw": "SPL Governance",
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

    if (GOVERNANCE_PROGRAM_IDS.has(pid)) {
      const decoded = describeGovernanceInstruction(ix, data);
      if (decoded) {
        lines.push(...decoded);
        return lines;
      }
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

// ── SPL Governance decoders ───────────────────────────────────────────
//
// Discriminators (first byte of instruction data):
//   1  = DepositGoverningTokens { amount: u64 }
//   2  = WithdrawGoverningTokens
//   13 = CastVote { vote: Vote }
//   15 = RelinquishVote
//
// The Vote enum in CastVote data[1..] is Borsh:
//   variant 0 = Approve(Vec<VoteChoice>)   -> YES
//   variant 1 = Deny                       -> NO
//   variant 2 = Abstain
//   variant 3 = Veto
//
// Returns null on any shape mismatch so the caller falls to the raw dump
// (safer than a misleading label). The account-index picks below come
// straight from the SPL Governance program's expected account layout.

const VOTE_KIND_NAMES: Record<number, string> = {
  0: "YES (Approve)",
  1: "NO (Deny)",
  2: "ABSTAIN",
  3: "VETO",
};

function describeGovernanceInstruction(
  ix: TransactionInstruction,
  data: Buffer
): string[] | null {
  if (data.length < 1) return null;
  const disc = data[0];

  switch (disc) {
    case 1: {
      // DepositGoverningTokens
      // data: [1][u64 LE amount]  (9 bytes total)
      if (data.length < 9) return null;
      if (ix.keys.length < 6) return null;
      const amount = data.readBigUInt64LE(1);
      return [
        `        -> GOVERNANCE DEPOSIT ${amount.toString()} (raw base units)`,
        `           realm                ${acct(ix, 0)}`,
        `           governing_token_holding ${acct(ix, 1)}`,
        `           source               ${acct(ix, 2)}`,
        `           governing_token_owner ${acct(ix, 3)}`,
        `           source_authority     ${acct(ix, 4)}`,
      ];
    }
    case 2: {
      // WithdrawGoverningTokens — data is just [2]
      if (data.length !== 1) return null;
      if (ix.keys.length < 5) return null;
      return [
        `        -> GOVERNANCE WITHDRAW governing tokens`,
        `           realm                ${acct(ix, 0)}`,
        `           governing_token_holding ${acct(ix, 1)}`,
        `           destination          ${acct(ix, 2)}`,
        `           governing_token_owner ${acct(ix, 3)}`,
        `           token_owner_record   ${acct(ix, 4)}`,
      ];
    }
    case 13: {
      // CastVote — data: [13][voteKind][...]
      if (data.length < 2) return null;
      if (ix.keys.length < 8) return null;
      const voteKind = data[1] as number;
      const kindName = VOTE_KIND_NAMES[voteKind] ?? `unknown vote kind ${voteKind}`;
      return [
        `        -> GOVERNANCE CAST VOTE: ${kindName}`,
        `           realm                ${acct(ix, 0)}`,
        `           governance           ${acct(ix, 1)}`,
        `           proposal             ${acct(ix, 2)}`,
        `           proposal_owner_record ${acct(ix, 3)}`,
        `           voter_token_owner_record ${acct(ix, 4)}`,
        `           voter (authority)    ${acct(ix, 5)}`,
      ];
    }
    case 15: {
      // RelinquishVote — data is just [15]
      if (data.length !== 1) return null;
      if (ix.keys.length < 6) return null;
      return [
        `        -> GOVERNANCE RELINQUISH VOTE`,
        `           realm                ${acct(ix, 0)}`,
        `           governance           ${acct(ix, 1)}`,
        `           proposal             ${acct(ix, 2)}`,
        `           voter_token_owner_record ${acct(ix, 3)}`,
        `           vote_record          ${acct(ix, 4)}`,
      ];
    }
    default:
      return null;
  }
}

// Silence unused-var lint if PublicKey ends up unused after tree-shaking.
void PublicKey;
