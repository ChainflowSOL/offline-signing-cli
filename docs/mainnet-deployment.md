# Mainnet Deployment Requirements & Playbook

**Status:** DRAFT — iterate before executing
**Owner:** kym0211
**Program name:** Vector (custom Anchor program)
**Repo:** offline-signing-cli, branch `feat/vector-integration`
**Devnet program ID (current):** `DkKZTgUDgkqUu5tck69uQJKf1deNzSY7YcU8F47oLXPZ`
**Mainnet program ID (planned):** _to be generated with a fresh keypair; see §5.2_

This document captures everything that needs to be true — or a conscious accepted risk — before we deploy Vector to Solana mainnet-beta. Every unchecked item below is a live gate.

---

## 1. Executive summary

Vector is a custom on-chain Anchor program plus a TypeScript CLI that lets a cold Ed25519 wallet authorize SOL/SPL/stake/governance operations by signing a 32-byte hashchain digest instead of a full Solana transaction. On mainnet the same architecture holds — but the risk shape changes: any bug that only bites when *real* value is behind the vault is now catastrophic instead of educational.

Three categories of concern this doc covers:

1. **Correctness gates** — what has to be true about the code before it touches mainnet SOL
2. **Operational gates** — keys, tooling, RPC access, monitoring
3. **Ongoing care** — rotation, upgrade authority, incident response

---

## 2. Go / no-go checklist (pre-deployment)

Nothing gets deployed until every "must-fix" item is checked.

### 2.1 Correctness gates

- [ ] **Audit fix F5 landed** — bind `program_id` (and optionally cluster tag) into the signed digest. See §3.1. **Must-fix.**
- [ ] **All committed audit fixes verified end-to-end on devnet** with the current `.so`. Not just adversarial + coverage suites, but a real transfer + stake round-trip + close cycle. **Must-fix.**
- [ ] **Anchor test suite passes** locally (`anchor test`). Local environment currently broken by system libc drift; see §6.1 for remediation.
- [ ] **3-layer LLM audit report** (`audit/REPORT.md`) reviewed. Every OPEN finding has a status: fixed / accepted / deferred with a written justification.
- [ ] **Optional but strongly recommended for real value**: paid audit by Neodyme / OtterSec / Zellic. Ballpark: $15k–$50k, 2–6 weeks. Do NOT hold real value without this if fund exposure exceeds ~$100k.

### 2.2 Operational gates

- [ ] **Mainnet program keypair** generated fresh (see §5.2). Never the same keypair as devnet.
- [ ] **Mainnet program ID** substituted into `programs/vector/src/lib.rs` (`declare_id!`), `Anchor.toml`, and `src/utils/vector.ts` (`VECTOR_PROGRAM_ID`). Confirmed via `anchor keys sync` + manual grep.
- [ ] **Program upgrade authority decided** (§5.3). Multisig or immutable strongly preferred; single-key acceptable only for a pure test deploy that will be closed within days.
- [ ] **Deployer wallet funded** with enough SOL to cover deploy + test ops + slack. See §4 for numbers.
- [ ] **A separate paid RPC endpoint** (Helius / QuickNode / Triton) configured. Public mainnet endpoints rate-limit heavily and are not reliable for institutional workflows.
- [ ] **Cold wallet keypair generated on an air-gapped device** and backed up per §5.5. Never touch the cold key on a networked machine.
- [ ] **Vault PDA verified deterministic** — compute the intended vault PDA client-side (`findVaultPda`) and confirm it matches what init-authority will create, before funding it.
- [ ] **Broadcast RPC secrets** stored securely; not committed to git.

### 2.3 Documentation gates

- [ ] This document reviewed and every "TBD" resolved.
- [ ] Incident response runbook drafted (§9).
- [ ] Post-mortem template ready.
- [ ] Public README updated with the mainnet program ID (only after successful deploy).

---

## 3. Known gaps to close before mainnet

### 3.1 Audit finding F5 — cross-cluster / program-id digest binding (INFO → must-fix for mainnet)

**Current state:** `digest = sha256(seed || ACTION_TAG || sub_ix_data)` — does not include the program ID or a cluster identifier.

**Why it matters on mainnet:** the on-chain execution and replay protection are safe *within* a given program-ID + realm state, but a signature computed against seed S at program X could theoretically be replayed against a differently-deployed program Y if seed S ever exists there. Practical exploitability is very low — initial-seed derivation mixes slot/timestamp — but it's the kind of thing that shows up in a post-mortem after a mistake elsewhere.

**Change required:**
- On-chain (`programs/vector/src/execute.rs`, `close.rs`, `initialize.rs`):
  ```rust
  let digest = sha256(&[
      &seed,
      &[ACTION_EXECUTE],
      &crate::ID.to_bytes(),     // NEW
      &sub_ix_data,
  ]);
  ```
- Client (`src/utils/vector.ts` `digestExecute` / `digestClose`): same addition
- Bump internal wire version if you want to be paranoid; not strictly needed since there's no signed legacy state yet

**Cost:** ~30 min of work + smoke tests + redeploy. Do it before or as part of the mainnet deploy commit.

### 3.2 Local Anchor test suite doesn't run (system libc drift)

Not a code issue. The current machine has glibc 2.42 and solana-test-validator's ed25519 precompile dispatch fails against it. Options:

1. Run tests in a Docker container based on an older Debian/Ubuntu (Ubuntu 22.04 works)
2. Run tests against a paid devnet RPC (Anchor supports `[test.validator]` overrides)
3. Move test-validator invocation into CI on a controlled image

**Blocker for mainnet?** No, because the same code paths *have* passed on both a working local validator (earlier session) and on devnet (deploy + smoke test on 2026-07-07). But we should restore the ability to run local tests for future changes.

### 3.3 Not-yet-tested end-to-end on devnet after audit fixes

The audit fix commits are:

- `edf2886` fix(program): use stored vault_bump and forbid self-CPI
- `aa166ef` fix(cli): recompute digest offline and decode sub-ix in sign UI
- `25eea89` fix(cli): use round-trip-verified meta.recipient for ATA auto-create
- `4c6c964` test: add offline adversarial smoke suite and function coverage harness

The on-chain `.so` with F3+F4 hasn't been re-deployed to devnet; the client-side F1+F2 changes are exercised only in the offline smoke suite. Before mainnet:

- [ ] Redeploy `.so` to devnet
- [ ] Full E2E: init-authority → sol-transfer → sign → broadcast → verify seed advances on chain
- [ ] Repeat for token-transfer, one stake op, one close cycle
- [ ] If governance is in scope, one governance-cast-vote against any live devnet realm

### 3.4 Governance flow not verified against a live realm

Client-side tests pass with synthetic payloads (`smoke/function-coverage.ts` cases F8–F11) but no governance instruction has actually been executed on-chain. The SPL Governance builders in `@solana/spl-governance` are widely used, so the risk is low, but treat it as unproven until at least one devnet cast-vote lands.

---

## 4. Cost & resource requirements

### 4.1 One-time SOL costs (mainnet deployer wallet)

| Item | SOL | Notes |
|---|---|---|
| Program deploy (~300 KB `.so`) | 2.2 – 2.7 | Includes rent for the program buffer accounts. Anchor's default. |
| Program upgrade later (per upgrade) | 2.2 – 2.7 | Same as deploy — buffers get re-allocated. |
| IDL upload | ~0.05 | Anchor writes IDL to a separate account. |
| Per `init-authority` (per cold key) | 0.002 | State PDA rent. Refunded on close. |
| Per `sol-transfer` | 0.000005 | Base tx fee. Ignore priority fees for now. |
| Per `stake-create` | ≥1.003 | 1 SOL min delegation + rent. Recoverable via stake-withdraw. |
| Per SPL ATA created | ~0.002 | Recoverable when the ATA is closed. |

**Deploy-only budget:** 3 SOL, comfortably 4.
**Deploy + smoke test:** 4–5 SOL.
**Deploy + full test (incl. staking round-trip):** 5–7 SOL, of which ~1 SOL is recoverable.

### 4.2 Recurring costs (post-launch, per user)

| Item | Frequency | SOL |
|---|---|---|
| `init-authority` per new authority | one-time | ~0.002 |
| Tx fees for `execute` broadcasts | per tx | 0.000005 base + optional priority fee |
| Priority fees during network congestion | occasional | can spike 100–1000× base fee |

Priority fee volatility is the operational cost users notice.

### 4.3 Infrastructure / non-SOL

- **Paid RPC endpoint** (Helius / QuickNode / Triton): free tier usually works for the CLI's per-tx call volume. If you're monitoring or batch-processing, expect $50–$500/mo depending on scale.
- **Monitoring** (Grafana / self-hosted): TBD depending on how you monitor vault balances.
- **CI runner** for anchor tests on merges: GitHub Actions is fine; SBPF builds are slow (~30–90 s), so cache aggressively.

---

## 5. Deployment operational decisions

### 5.1 Deployment target

Mainnet-beta (`https://api.mainnet-beta.solana.com` or your paid RPC). No mainnet-forks, no localnet, no genesis mainnet. Just mainnet-beta.

### 5.2 Program keypair

**Do NOT reuse the devnet program keypair on mainnet.** Generate fresh:

```bash
solana-keygen new --no-bip39-passphrase -o keys/mainnet-vector-keypair.json
solana-keygen pubkey keys/mainnet-vector-keypair.json  # → this is the mainnet program ID
```

Store the keypair (in `keys/` — add to `.gitignore`) with the same care as any critical secret:
- Encrypted backup in cold storage
- Never committed
- Never on a networked machine after initial deploy — needed only for upgrades

If the upgrade authority is a multisig, the program keypair only needs to exist during the initial deploy; upgrades don't need it thereafter (upgrades sign with the upgrade authority, not the program keypair).

### 5.3 Upgrade authority

Three choices, in order of increasing security and operational cost:

**Option A: single-key upgrade authority** (a hardware wallet)
- Simplest
- Single point of failure: compromise = malicious upgrade possible
- **Acceptable only for a test deployment that will be closed within days.**

**Option B: multisig (Squads V4)**
- Standard for institutional programs
- Set the upgrade authority to a Squads multisig at deploy time
- Upgrades require N-of-M signatures from the multisig members
- **Recommended for anything holding real user value.**

**Option C: immutable**
- Set upgrade authority to `None` after deploy
- Program can never be upgraded, ever
- No bug fixes possible; if a critical bug is found, all users must migrate to a new program ID
- **Only appropriate once the code is battle-tested — years, not months.**

Decision: **TBD — must be decided before deploy**.

### 5.4 CLI program-ID substitution

The mainnet program ID must be substituted in three places:

1. `programs/vector/src/lib.rs` — `declare_id!("<mainnet-program-id>");`
2. `Anchor.toml` — `[programs.mainnet]` section
3. `src/utils/vector.ts` — `VECTOR_PROGRAM_ID = new PublicKey("<mainnet-program-id>");`

Anchor CLI provides `anchor keys sync` for #1 and #2 automatically. #3 must be updated by hand.

Confirmed via:
```bash
grep -r <mainnet-program-id> programs/ src/ Anchor.toml
grep -r <devnet-program-id>  programs/ src/ Anchor.toml   # must return zero results
```

### 5.5 Cold-wallet keypair generation and custody

Cold-wallet keys are the entire security model. They should be:

- **Generated on an air-gapped machine.** A laptop that has never touched a network is fine; a fresh Raspberry Pi is fine; a hardware wallet is best.
- **Never copied to a networked machine.** Not once. Not "just to test."
- **Backed up as a written 12/24-word mnemonic** or split into shards (Shamir).
- **Kept in a physically secure location.** Ideally two copies in geographically separated locations.
- **Documented in a runbook** so a successor can operate the wallet after a key-holder is unavailable.

If you're using a hardware wallet (Ledger, Trezor) as the cold device: verify that the CLI's ed25519 signing path can be routed through the device. Currently our `sign.ts` does not integrate with any HSM; extending it to use `@ledgerhq/hw-app-solana` or similar is a separate work item.

### 5.6 RPC endpoint strategy

Public RPCs (`api.mainnet-beta.solana.com`) are rate-limited and unreliable for real workloads. Options:

- **Helius** — free tier is generous; paid starts at ~$50/mo; supports all standard methods
- **QuickNode** — similar pricing; more customization
- **Triton** — more infra-heavy; better for high-volume
- **Self-hosted RPC node** — $500+/mo in hosting; not worth it unless you have very high throughput

Decision needed: TBD.

---

## 6. Deployment procedure

### 6.1 Pre-deploy checklist run-through

Working through §2 must be complete. Do not skip. In particular:

- F5 fix committed and pushed
- Devnet e2e tests re-run with the updated `.so`
- New mainnet keypair generated, backed up
- Upgrade authority pubkey/multisig ready
- Deployer wallet funded

### 6.2 Deploy

```bash
# Confirm current git state
git log --oneline -5
git status --short   # must be clean

# Verify program ID substitution
anchor keys sync
anchor build

# Confirm the built .so was generated
ls -la target/deploy/vector.so

# Deploy to mainnet
anchor deploy --provider.cluster mainnet-beta \
  --program-name vector \
  --program-keypair keys/mainnet-vector-keypair.json

# Verify
solana program show <MAINNET_PROGRAM_ID> --url mainnet-beta
```

### 6.3 Set upgrade authority (if multisig or immutable)

**Multisig:**
```bash
solana program set-upgrade-authority <MAINNET_PROGRAM_ID> \
  --new-upgrade-authority <MULTISIG_PUBKEY> \
  --url mainnet-beta
```

**Immutable (irreversible!):**
```bash
solana program set-upgrade-authority <MAINNET_PROGRAM_ID> \
  --final \
  --url mainnet-beta
```

Verify:
```bash
solana program show <MAINNET_PROGRAM_ID> --url mainnet-beta
```

### 6.4 Deploy the IDL

```bash
anchor idl init --filepath target/idl/vector.json <MAINNET_PROGRAM_ID> --provider.cluster mainnet-beta
```

### 6.5 First transaction — init-authority for a test cold key

Do NOT do this with real funds yet. Use a fresh test cold key generated on an air-gapped machine, funded with a few cents of SOL. This proves the deployed program is callable end-to-end.

---

## 7. Progressive value ramp (post-deploy)

Do NOT put institutional funds behind a fresh mainnet deployment. Ramp gradually:

### Phase 1 — smoke (day 0-1)
- One test cold key
- 0.05 SOL in the vault
- Run: init-authority → sol-transfer 0.001 → sign → broadcast → close-authority
- Verify: recipient received the SOL, close refunded rent, seed on chain advanced then account destroyed
- **Cost: ~0.01 SOL. Recoverable at close.**

### Phase 2 — realistic operations (week 1)
- Second test cold key
- 1.05 SOL in the vault
- Run: stake-create (1 SOL) → stake-delegate → wait 1-2 epochs → stake-deactivate → wait 1 epoch → stake-withdraw → sol-transfer → close
- **Cost: ~1.06 SOL. Fully recoverable at close.**

### Phase 3 — one real user (week 2-4)
- Onboard one trusted user with a small production balance (0.5–5 SOL)
- Run normal operations
- Instrument alerting on the vault balance and seed advances

### Phase 4 — general availability (month 2+)
- After Phase 3 has demonstrated stability across at least 100 real operations without incident
- Publish the mainnet program ID, allow open onboarding

**Rule:** don't accelerate through phases just because things "seem to work." Real bugs surface at the boundaries between phases; the ramp is what limits the blast radius.

---

## 8. Governance flow — additional mainnet caveats

If governance is in scope on mainnet:

- **Which DAO?** — SPL Governance is the standard, but each DAO deploys its own realm. You need the realm pubkey, governance pubkey, governing token mint, and proposal pubkey per operation.
- **Governance token cost.** Depositing into a realm requires having governance tokens. For Realms (the flagship instance), this is often free-ish testnet-style tokens. For live DAOs (Mango, Marinade, Metaplex), you need to actually hold the tokens — which cost real money.
- **Voting weight matters.** A vote with 1 token of weight is functionally identical to no vote at all in most DAOs. Only test with meaningful voting weight if you're testing the *vote arithmetic*; testing the *tx flow* only needs 1 token.
- **Proposal state matters.** `cast-vote` only works on `Voting` state proposals. `relinquish-vote` only during voting or after finalization depending on config. Both fail cleanly, but plan test proposal timing.
- **`describe.ts` decoder coverage.** Currently only the canonical SPL Governance program ID (`GovER5…`) gets clear-signing. Custom governance deployments fall to raw dump. If you plan to interact with a non-standard governance program, add its ID to `GOVERNANCE_PROGRAM_IDS` in `describe.ts` — see the file for the specific line.

---

## 9. Ongoing operational care

### 9.1 Monitoring

Set up alerts on:

- **Vault PDA balance drops** — any unexpected debit
- **State PDA seed advances** — any unexpected `execute`
- **Program upgrade authority changes** — very rare event, should be tracked
- **RPC endpoint availability** — SLA-tracked
- **Priority fee spikes** — signal that broadcasts may need retry

Recommended: Helius Webhooks (free tier includes account-change notifications) or Solscan API polling.

### 9.2 Upgrade procedure

**Only if upgrade authority is not immutable.**

1. Land the fix on a branch, get review
2. Redeploy to devnet, run adversarial + coverage suites, run real smoke test
3. Schedule the mainnet upgrade for a low-activity window
4. Draft an announcement — users may want to pause operations during the upgrade
5. Execute the upgrade via the multisig (or single key if that's the model)
6. Verify:
   - `solana program show` reports the new hash
   - Immediate post-upgrade smoke test (init-authority, sol-transfer, close) works
   - No unexpected state PDA closures
7. Announce upgrade completion

### 9.3 Cold-key rotation

If a cold key is compromised or needs to be rotated (e.g., personnel change):

1. Draft a new authority address from a fresh cold key
2. Init the new Vector PDA for the new cold key
3. Offline-sign a transfer of all funds (SOL, all SPL ATAs, deactivate + withdraw all stakes, undeposit all governance tokens) from the old vault to the new vault or new keeper
4. Close the old Vector PDA to reclaim rent

**No on-chain rotation** in the current design (F5+ TODO): the cold key is baked into the state PDA's authority field and can only be replaced by close + reinit. This is intentional — simpler security model — but means rotation is a "full unwind + reinstall" not a single ix.

### 9.4 Incident response

If you observe anomalous state (unexpected vault debit, unauthorized seed advance, program upgrade you did not initiate):

1. **Do not sign anything with the cold key** until the cause is understood
2. Check `solana confirm <tx>` for the anomalous transaction — get the sender pubkey, signer set, fee payer
3. Check the program upgrade history: `solana program show <MAINNET_PROGRAM_ID>` reports the last upgrade
4. If the upgrade authority is a multisig, check who signed the upgrade
5. If confirmed adversarial: rotate the cold key immediately per §9.3, and file a post-mortem
6. Do NOT communicate any details of the incident publicly until the cold key is rotated and funds are safe

---

## 10. Explicit accepted risks (must be reviewed and signed off)

Things this deployment does NOT protect against. All must be acknowledged before mainnet:

1. **The on-chain Vector program has not been paid-audited.** Three LLM audit passes turned up 5 findings (1 HIGH, 1 MEDIUM, 3 lower); 4 are fixed, 1 is planned. LLM audits are not equivalent to Neodyme/OtterSec/Zellic.
2. **The Solana runtime itself is not audited by us.** If Solana ships a bug in the ed25519 precompile or a system program we call, that is not something Vector can defend against.
3. **The hot wallet is a single point of griefing.** A compromised hot wallet cannot steal funds (proven in audit), but it can refuse to broadcast — permanent denial of service until the operator moves to a new hot wallet.
4. **The cold wallet is a single point of failure.** If the cold wallet's mnemonic is lost, the vault is unrecoverable. If the cold wallet is compromised, the vault is drained.
5. **Solana network downtime is unmitigated.** If Solana halts, no operations are possible.
6. **Priority fee spikes can price out low-fee broadcasts.** During congestion, the CLI does not adaptively bid; broadcast may fail silently until fees ease.

---

## 11. Sign-off

Before executing the deployment, get explicit sign-off on this document from:

- [ ] Engineering lead (correctness gates)
- [ ] Security lead (audit status, accepted risks)
- [ ] Operations lead (RPC, keypair custody, incident response)
- [ ] Business / product (which DAO for governance testing, target user profile)

---

## Appendix A — Commands cheat-sheet

```bash
# ── keypair generation ─────────────────────────────────────────────
solana-keygen new --no-bip39-passphrase -o keys/mainnet-vector-keypair.json
solana-keygen pubkey keys/mainnet-vector-keypair.json

# ── build ──────────────────────────────────────────────────────────
anchor keys sync
anchor build

# ── deploy ─────────────────────────────────────────────────────────
solana config set --url mainnet-beta
solana balance
anchor deploy --provider.cluster mainnet-beta

# ── verify ─────────────────────────────────────────────────────────
solana program show <MAINNET_PROGRAM_ID> --url mainnet-beta

# ── upgrade authority ──────────────────────────────────────────────
solana program set-upgrade-authority <MAINNET_PROGRAM_ID> \
  --new-upgrade-authority <NEW_AUTHORITY> --url mainnet-beta
solana program set-upgrade-authority <MAINNET_PROGRAM_ID> \
  --final --url mainnet-beta   # IMMUTABLE — irreversible!

# ── IDL ────────────────────────────────────────────────────────────
anchor idl init --filepath target/idl/vector.json <MAINNET_PROGRAM_ID> \
  --provider.cluster mainnet-beta

# ── first-run smoke test ───────────────────────────────────────────
pnpm dev init-authority --env mainnet --cold <TEST_COLD_PUBKEY> \
  --payer keys/mainnet-hot-wallet.json
```

---

## Appendix B — Known good tool versions

| Tool | Tested version |
|---|---|
| anchor CLI | 0.32.1 |
| solana CLI | 3.0.13 (Agave) |
| rustc (host) | 1.89.0 |
| rustc (SBPF) | 1.84.1 (platform-tools v1.51) |
| node | 18+ |
| pnpm | 10+ |

Higher versions may work but have not been verified for this repository. **Do not deploy on untested toolchain versions.**

---

## Appendix C — Open questions

Things this document does not yet resolve, and must resolve before deploy:

- [ ] Who holds the multisig keys (if we go multisig)?
- [ ] Which RPC provider are we paying for?
- [ ] Which specific DAO (if any) do we test governance against on mainnet?
- [ ] What's our monitoring stack?
- [ ] Who is on-call for the first 30 days after launch?
- [ ] Have we written the user-facing security notes for cold-key custody?

Fill these in before executing §6.

---

_Last updated: 2026-07-08_
