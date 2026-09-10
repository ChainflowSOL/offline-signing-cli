# offline-signer-cli

An offline Solana transaction signing CLI backed by a custom on-chain program
("Vector"). The cold wallet never signs a full Solana transaction — it signs
only a 32-byte digest, which is verified on-chain via the native Ed25519
precompile + instruction introspection.

This replaces the previous durable-nonce design. Durable nonces are being
deprecated; Vector uses no nonces and has no per-cluster external dependency
beyond the always-deployed Ed25519 precompile.

## Status and disclaimer

**This software has not been professionally audited. Use it at your own risk.**

The program is deployed and working, and the offline-signing flow has been
exercised end to end on mainnet with real funds. That is not the same as being
safe to put a treasury behind. Specifically:

- **No third-party audit.** The code has been through three independent review
  passes (a targeted security review, a multi-agent code review, and a
  hypothesis-driven probe of the on-chain program), which found five issues -
  all since fixed and re-verified on chain. Those passes are a useful
  pre-audit. They are not a substitute for a firm like Neodyme, OtterSec or
  Zellic actually reading the code.
- **Losing the cold key loses the funds.** There is no recovery path, no social
  recovery and no backdoor. That is the design.
- **The offline machine is your responsibility.** The security argument assumes
  the signing machine is genuinely air-gapped and the cold key was generated
  there. Neither is something this tool can enforce.

If you are evaluating this for anything beyond experimentation, read
`docs/mainnet-deployment.md` - it lists the accepted risks and the operational
gates in full.

Licensed under Apache-2.0, which means it is provided "as is", without warranty
of any kind. See `LICENSE`.

## Architecture

### System view

```mermaid
flowchart LR
    subgraph OFFLINE["🔒 OFFLINE machine (air-gapped)"]
        ColdKey[/"cold-wallet.json<br/>Ed25519 secret key"/]
        SignCmd["pnpm dev sign"]
        ColdKey --> SignCmd
    end

    subgraph ONLINE["🌐 ONLINE machine (hot wallet)"]
        HotKey[/"hot-wallet.json<br/>fee payer"/]
        ConstructCmd["sol-transfer / token-transfer<br/>stake-* / governance-*<br/>close-authority"]
        BroadcastCmd["broadcast"]
        HotKey --> BroadcastCmd
        ConstructCmd --> Unsigned[/"unsigned-tx.json<br/>(digest only)"/]
        Signed[/"signed-tx.json<br/>(64-byte ed25519 sig)"/] --> BroadcastCmd
    end

    subgraph CHAIN["⛓️ Solana"]
        Precompile["Ed25519 precompile<br/>Ed25519SigVerify1111…"]
        VectorProg["Vector program<br/>FkCL7nUJym3Yc9PVgr7TQ3TRn5uJApu7FdGSV1X6rKVd"]
        StatePDA[("Vector PDA<br/>seed = ['vector', auth]<br/>{authority, seed, bumps}")]
        VaultPDA[("Vault PDA<br/>seed = ['vault', auth]<br/>holds SOL + SPL ATAs")]
        VectorProg -.owns.-> StatePDA
        VectorProg -.signs CPI for.-> VaultPDA
    end

    Unsigned ==USB==> SignCmd
    SignCmd --> Signed
    Signed ==USB==> BroadcastCmd
    BroadcastCmd --> Precompile
    BroadcastCmd --> VectorProg
    ConstructCmd -.read seed.-> StatePDA
```

### Per-transaction sequence

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant Hot as Hot CLI (online)
    participant RPC as Solana RPC
    participant Cold as Cold CLI (offline)
    participant Prog as Vector program

    U->>Hot: sol-transfer --cold X --recipient Y --amount Z
    Hot->>RPC: fetch Vector PDA seed
    RPC-->>Hot: current seed
    Hot->>Hot: digest = sha256(seed ‖ ACTION ‖ sub_ix)
    Hot-->>U: unsigned-tx.json (digest)

    Note over Hot,Cold: USB transfer →

    U->>Cold: sign --keypair cold-wallet.json
    Cold->>Cold: ed25519 sign(digest, cold_key)
    Cold-->>U: signed-tx.json (signature)

    Note over Cold,Hot: ← USB transfer

    U->>Hot: broadcast
    Hot->>Hot: nacl.verify(sig, digest, cold_pub) [defense]
    Hot->>RPC: tx = [ed25519 precompile, vector execute]
    RPC->>Prog: execute(ed25519_ix_index, sub_ix_data)
    Prog->>Prog: load precompile from instructions sysvar
    Prog->>Prog: check pubkey == authority<br/>check message == sha256(seed ‖ ACTION ‖ sub_ix)
    Prog->>Prog: invoke_signed sub-instructions<br/>(vault PDA signs)
    Prog->>Prog: seed ← sha256(seed ‖ digest)
    Prog-->>RPC: ok
    RPC-->>Hot: tx signature + confirmation
    Hot-->>U: explorer link
```

### PDAs per authority

| PDA          | Seeds                       | Owner          | Holds          |
|--------------|-----------------------------|----------------|----------------|
| **Vector**   | `["vector", authority]`     | this program   | state (authority, hashchain seed, bumps) |
| **Vault**    | `["vault",  authority]`     | System program | SOL + SPL ATAs |

State and value are split because `SystemProgram.transfer` rejects a `from`
account that carries data — so SOL must live on a system-owned PDA.

## Replay protection (hashchain)

Each `execute` advances the on-chain seed:

```
digest      = SHA-256(seed || ACTION_EXECUTE || program_id || sub_ix_data)
new_seed    = SHA-256(seed || digest)
```

A pre-signed digest is bound to the seed it was computed against. Once the
seed advances, the old signature can never be replayed.

`program_id` is bound in as well, so a signature valid against one deployment
can never be replayed against a different one (e.g. devnet -> mainnet).

`close` uses the same scheme with `ACTION_CLOSE || program_id || close_to_pubkey`.

## On-chain program (Anchor)

Located at `programs/vector/`. Three instructions:

| Instruction  | Inputs                                     | Effect |
|--------------|--------------------------------------------|--------|
| `initialize` | —                                          | Creates state PDA; records initial seed from clock |
| `execute`    | `ed25519_ix_index: u8`, `sub_ix_data: Vec<u8>` | Verifies precompile, CPI-executes each sub-instruction with the Vault PDA as signer, advances seed |
| `close`      | `ed25519_ix_index: u8`                     | Verifies precompile, drains Vault to `close_to`, closes state PDA |

Sub-instruction wire format (consumed by `execute`):

```
[u8 num_ixs]
per ix:
  [Pubkey program_id (32B)]
  [u8 num_accounts]
  per account:
    [Pubkey (32B)]
    [u8 flags]   bit0 = is_writable, bit1 = is_signer
  [u16 LE data_len]
  [data]
```

The Vault PDA is normally the only account that may be marked `is_signer` —
the program signs CPIs with the vault seeds via `invoke_signed`.

`execute` also accepts an **optional `co_signer`** account. When present, that
one additional pubkey may be a sub-instruction signer. This exists solely for
SPL Governance `CastVote`, which creates the vote record as part of voting and
therefore needs a rent payer that signs; the Vault PDA cannot pay rent. Anchor's
`Signer` type guarantees the co-signer really signed the transaction, and its
pubkey lives inside `sub_ix_data`, so it is covered by the cold wallet's
signature. Twelve of the thirteen commands pass no co-signer and keep the strict
vault-only rule.

## CLI commands

```
offline-signer <command> [options] [--env devnet|mainnet|<rpc-url>]
```

| Command             | Use on  | Description                                         |
|---------------------|---------|-----------------------------------------------------|
| `init-authority`    | Hot     | Initialize Vector + Vault PDAs for a cold pubkey    |
| `sol-transfer`      | Hot     | Build an unsigned SOL transfer                      |
| `token-transfer`    | Hot     | Build an unsigned SPL-token transfer                |
| `stake-create`      | Hot     | Build an unsigned vault-funded stake-account create (auths = Vault PDA) |
| `stake-delegate`    | Hot     | Build an unsigned delegate-to-validator             |
| `stake-deactivate`  | Hot     | Build an unsigned deactivate-stake                  |
| `stake-withdraw`    | Hot     | Build an unsigned withdraw-from-stake               |
| `governance-deposit` | Hot    | Deposit governance tokens into a DAO realm (grants voting weight) |
| `governance-cast-vote` | Hot  | Vote yes / no / abstain / veto on a proposal        |
| `governance-relinquish-vote` | Hot | Cancel a cast vote before the proposal finalizes |
| `governance-withdraw` | Hot    | Withdraw governance tokens back out of the realm    |
| `close-authority`   | Hot     | Build an unsigned close                             |
| `sign`              | **Cold**| Sign the digest in `unsigned-tx.json`               |
| `broadcast`         | Hot     | Assemble `[Ed25519 precompile, vector ix]` and send |

### Typical flow

```bash
# 1. Hot side: provision PDAs for the cold pubkey.
offline-signer init-authority \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --payer ./hot-wallet.json

# Fund the Vault PDA (printed by init-authority) with SOL/SPL tokens.

# 2. Hot side: prepare an unsigned transfer.
offline-signer sol-transfer \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --recipient <RECIPIENT_PUBKEY> \
  --amount 0.5 \
  --payer <HOT_PUBKEY>

# → writes unsigned-tx.json

# 3. Move unsigned-tx.json to the OFFLINE machine. Cold side:
offline-signer sign \
  --keypair ./cold-wallet.json \
  --unsigned ./unsigned-tx.json

# → writes signed-tx.json (a 64-byte Ed25519 signature over the digest)

# 4. Move signed-tx.json back to the ONLINE machine. Hot side:
offline-signer broadcast \
  --env devnet \
  --payer ./hot-wallet.json \
  --unsigned ./unsigned-tx.json \
  --signature ./signed-tx.json
```

### Institutional staking flow

Every stake operation funnels through the same `execute` instruction — the
cold wallet authorizes a `StakeProgram` sub-instruction signed by the Vault
PDA via CPI. The cold key never sees a blockhash.

| Concern | Where it lives |
|---|---|
| Funds | Vault PDA (`["vault", authority]`) |
| Stake / withdraw authority on every stake account | Vault PDA |
| Authorization to delegate / deactivate / withdraw | Cold-wallet Ed25519 signature over the digest |

Stake account addresses are **derived** from the Vault PDA via
`createAccountWithSeed`, so the same `--seed` string always produces the
same stake address. Pick any naming convention (e.g. `"validator-A-2026Q2"`).

```bash
# 1. Vault funds + creates a stake account; both authorities = Vault PDA.
offline-signer stake-create \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --seed "validator-A-2026Q2" \
  --amount 100 \
  --payer <HOT_PUBKEY>
# → unsigned-tx.json   ... sign ... broadcast

# 2. Delegate that stake to a validator's vote account.
offline-signer stake-delegate \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --stake <STAKE_PUBKEY> \
  --validator <VOTE_PUBKEY> \
  --payer <HOT_PUBKEY>
# → unsigned-tx.json   ... sign ... broadcast
# Takes effect at the next epoch boundary.

# 3. Start unwinding (deactivate); becomes withdrawable next epoch.
offline-signer stake-deactivate \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --stake <STAKE_PUBKEY> \
  --payer <HOT_PUBKEY>

# 4. Withdraw inactive stake back to a recipient (e.g. the Vault PDA).
offline-signer stake-withdraw \
  --env devnet \
  --cold <COLD_PUBKEY> \
  --stake <STAKE_PUBKEY> \
  --amount 100 \
  --recipient <VAULT_PDA_OR_OTHER> \
  --payer <HOT_PUBKEY>
```

**Notes for operators:**

- Minimum delegation on most clusters is **1 SOL** above rent (≈ 0.00228 SOL
  for a 200-byte stake account). `stake-create` with less will succeed but
  `stake-delegate` will fail with Stake program error `0xc`
  (`InsufficientDelegation`).
- The cold-side `sign` UI decodes the actual instruction bytes (not the
  producer's label) and shows the stake operation, account, validator and
  amount, so the human at the keys sees what they are authorizing.
- Multiple stake accounts per authority: use a distinct `--seed` for each.
  All inherit the Vault PDA as stake & withdraw authority, so one cold key
  controls the whole portfolio.
- Pre-signing: `signed-tx.json` produced offline is single-use (hashchain
  replay protection). Useful for break-glass "deactivate everything"
  procedures held in escrow.

### DAO governance flow

The four `governance-*` commands drive **SPL Governance** (Realms, Marinade,
Metaplex and most on-chain DAOs). The Vault PDA is the `governing_token_owner`,
so every governance action requires the cold-wallet signature.

Deposit first: voting weight comes from tokens held inside the realm, not from
tokens sitting in the vault's ATA.

```bash
# 1. Deposit governance tokens into the realm -> grants voting weight
offline-signer governance-deposit \
  --env mainnet \
  --cold <COLD_PUBKEY> \
  --governance-program GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw \
  --realm <REALM_PUBKEY> \
  --mint <GOVERNING_TOKEN_MINT> \
  --amount 500 \
  --payer <HOT_PUBKEY>
# ... sign ... broadcast

# 2. Vote on a proposal
offline-signer governance-cast-vote \
  --env mainnet \
  --cold <COLD_PUBKEY> \
  --governance-program GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw \
  --realm <REALM_PUBKEY> \
  --governance <GOVERNANCE_PUBKEY> \
  --proposal <PROPOSAL_PUBKEY> \
  --proposal-owner-record <PROPOSAL_CREATOR_TOKEN_OWNER_RECORD> \
  --mint <GOVERNING_TOKEN_MINT> \
  --vote yes \
  --payer <HOT_PUBKEY>

# 3. Optionally cancel that vote while the proposal is still open
offline-signer governance-relinquish-vote \
  --env mainnet --cold <COLD_PUBKEY> \
  --governance-program <GOV> --realm <REALM> \
  --governance <GOVERNANCE> --proposal <PROPOSAL> \
  --mint <MINT> --payer <HOT_PUBKEY>

# 4. Withdraw the tokens back to the vault's ATA
offline-signer governance-withdraw \
  --env mainnet --cold <COLD_PUBKEY> \
  --governance-program <GOV> --realm <REALM> \
  --mint <MINT> --payer <HOT_PUBKEY>
```

**Notes for operators:**

- `--vote` accepts `yes`, `no`, `abstain` or `veto`.
- **`cast-vote` prints an `!! ADDITIONAL SIGNER REQUIRED !!` warning at signing
  time. This is expected.** SPL Governance creates the vote record as part of
  casting a vote, and the rent payer must sign; the Vault PDA cannot pay rent,
  so the hot wallet co-signs that one instruction. Verify the named pubkey is
  your own hot wallet before confirming. No other command does this.
- `governance-deposit` needs the voter's `TokenOwnerRecord` to exist. If it
  does not, `broadcast` creates it hot-side first as an unsigned pre-instruction
  - the same treatment destination ATAs get. Rent comes from the fee payer.
- `governance-withdraw` is rejected by SPL Governance while any cast vote is
  still active. Relinquish first.
- Only the canonical SPL Governance program ID gets a decoded signing screen.
  A DAO running a custom governance program falls back to a full raw dump
  (program, every account, hex data) - still safe, just less readable. Add the
  program ID to `GOVERNANCE_PROGRAM_IDS` in `src/utils/describe.ts` to get a
  friendly decode.

## What the cold wallet actually verifies

`sign` never trusts the online machine. Before anything is displayed or signed
it independently recomputes the digest from the raw instruction bytes in
`unsigned-tx.json` and refuses if the result differs from the digest the file
claims:

```
REFUSING TO SIGN: the digest in this file does not match its own instructions.
```

That is why `unsigned-tx.json` carries `seedBase64` - the public on-chain
hashchain seed - so the offline machine can rebuild the digest with no network
access. The confirmation screen is then rendered by decoding those same bytes:

```
Action: EXECUTE the following sub-instruction(s):
  [0] System Program (11111111111111111111111111111111)
        -> SOL TRANSFER 0.05 SOL (50000000 lamports)
           from GepJXzCrwebWe1qCD4Hace1A9bbwVru5Fcn8bQJTGdzA
           to   3iAnUKLYgszyh9A3HZxnSnuhhu7kRYY7edAxTP2R9MfC
  ---
  Producer label (UNVERIFIED): Transfer 0.05 SOL to 3iAnUKLY...
```

The producer's own description is shown last and explicitly marked
`UNVERIFIED`, because nothing binds it to what will execute. Instructions from
programs the decoder does not recognise are dumped in full - program ID, every
account with its flags, and the raw data in hex - so a sub-instruction can
never hide behind a friendly-looking label.


## Setup

```bash
pnpm install
anchor build          # builds the on-chain program (target/deploy/vector.so)
anchor test           # runs the integration tests against solana-test-validator
```

### Toolchain

| Tool          | Version tested |
|---------------|----------------|
| anchor        | 0.32.1         |
| solana CLI    | 3.0.13 (Agave) |
| rustc (host)  | 1.89.0         |
| rustc (SBPF)  | 1.84.1 (platform-tools v1.51) |
| node          | 18+            |
| pnpm          | 10+            |

The `Cargo.lock` pins `proc-macro-crate`, `indexmap`, and
`unicode-segmentation` to versions compatible with platform-tools v1.51's
bundled cargo 1.84. Upgrade pins when newer platform-tools ship.

## Deploying the program

The program is deployed at `FkCL7nUJym3Yc9PVgr7TQ3TRn5uJApu7FdGSV1X6rKVd` on
**mainnet-beta**, and at the same address on devnet for testing. That ID is baked
into `declare_id!()`, `Anchor.toml` and `src/utils/vector.ts`.

Because the digest binds the program ID (see below), a signature produced against
one deployment can never be replayed against another - so a private deployment is
fully isolated from the public one. For your own:

```bash
# Generate a fresh program keypair
solana-keygen new --no-bip39-passphrase -o target/deploy/vector-keypair.json --force

# Sync the new pubkey into declare_id!() and Anchor.toml
anchor keys sync

# Update src/utils/vector.ts → VECTOR_PROGRAM_ID to the new value

anchor build
anchor deploy --provider.cluster devnet
```

## Tests

```bash
anchor test
```

Covers: initialize, SOL transfer happy path, replay rejection, SPL-token
transfer via CPI, close (with vault drain), wrong-signer rejection,
tampered-digest rejection, missing-precompile rejection.

## Security notes

- Cold wallet only signs 32-byte digests. It never produces a Solana
  transaction signature and is never asked to sign a blockhash.
- The on-chain program rejects any Ed25519 precompile that uses
  cross-instruction data references — all signature/pubkey/message bytes
  must live inside the precompile's own instruction data.
- The program enforces exactly one signature per precompile instruction.
- `is_signer = true` in a sub-instruction is allowed only for the Vault PDA,
  or for the optional `co_signer` when one is supplied (used solely by
  `governance-cast-vote`). Both pubkeys are inside `sub_ix_data`, so the cold
  wallet's signature covers exactly who is permitted to sign.
- The hashchain initial seed mixes the slot and unix_timestamp from `Clock`
  so a close-and-reinit cycle cannot resurrect an old pre-signed digest.

