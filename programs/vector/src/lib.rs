use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    system_instruction,
    sysvar::instructions::{
        load_current_index_checked, load_instruction_at_checked, ID as IX_SYSVAR_ID,
    },
};
use sha2::{Digest, Sha256};

declare_id!("DkKZTgUDgkqUu5tck69uQJKf1deNzSY7YcU8F47oLXPZ");

// Native Ed25519 signature-verify precompile (deployed on every cluster).
pub const ED25519_PROGRAM_ID: Pubkey =
    pubkey!("Ed25519SigVerify111111111111111111111111111");

// Two PDAs per authority:
//   ["vector", authority] — the state PDA (this program owns it; holds data)
//   ["vault",  authority] — the vault PDA (system-owned; holds SOL + SPL ATAs)
// State and value are split because SystemProgram.transfer requires the
// `from` account to have zero data, which our state PDA does not.
pub const VECTOR_SEED: &[u8] = b"vector";
pub const VAULT_SEED: &[u8] = b"vault";

fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}

// Domain separation tags — make sure execute and close digests cannot collide
// even if their post-seed bytes happen to align.
pub const ACTION_EXECUTE: u8 = 0x00;
pub const ACTION_CLOSE: u8 = 0x01;

// Ed25519 precompile data layout (single-signature form):
//   [u8 num_sigs][u8 padding][14B offsets][64B signature][32B pubkey][32B message]
pub const ED25519_HEADER_LEN: usize = 16;
pub const ED25519_SIG_LEN: usize = 64;
pub const ED25519_PUBKEY_LEN: usize = 32;
pub const ED25519_MIN_DATA_LEN: usize =
    ED25519_HEADER_LEN + ED25519_SIG_LEN + ED25519_PUBKEY_LEN;
pub const SELF_REF: u16 = u16::MAX;

#[program]
pub mod vector {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let clock = Clock::get()?;
        let vector = &mut ctx.accounts.vector;
        vector.authority = ctx.accounts.authority.key();
        vector.bump = ctx.bumps.vector;
        vector.vault_bump = ctx.bumps.vault;
        // Initial seed mixes authority + on-chain entropy so a close+reinit
        // cannot resurrect old pre-signed digests.
        vector.seed = sha256(&[
            b"vector-init",
            ctx.accounts.authority.key().as_ref(),
            &clock.slot.to_le_bytes(),
            &clock.unix_timestamp.to_le_bytes(),
        ]);
        Ok(())
    }

    pub fn execute(
        ctx: Context<Execute>,
        ed25519_ix_index: u8,
        sub_ix_data: Vec<u8>,
    ) -> Result<()> {
        let authority = ctx.accounts.vector.authority;
        let seed = ctx.accounts.vector.seed;
        let vault_bump = ctx.accounts.vector.vault_bump;

        // 1. Expected digest = sha256(seed || ACTION_EXECUTE || sub_ix_data)
        let digest = sha256(&[&seed, &[ACTION_EXECUTE], &sub_ix_data]);

        // 2. Verify precompile signed (authority, digest)
        verify_ed25519_precompile(
            &ctx.accounts.instructions_sysvar,
            ed25519_ix_index,
            &authority,
            &digest,
        )?;

        // 3. Decode and CPI each sub-instruction (vault PDA signs)
        let sub_ixs = decode_sub_instructions(&sub_ix_data)?;
        execute_sub_instructions(&sub_ixs, ctx.remaining_accounts, &authority, vault_bump)?;

        // 4. Advance seed (replay protection)
        ctx.accounts.vector.seed = sha256(&[&seed, &digest]);

        Ok(())
    }

    pub fn close(ctx: Context<CloseVector>, ed25519_ix_index: u8) -> Result<()> {
        let vector = &ctx.accounts.vector;
        let close_to_key = ctx.accounts.close_to.key();
        let authority = vector.authority;
        let vault_bump = vector.vault_bump;

        let digest = sha256(&[&vector.seed, &[ACTION_CLOSE], close_to_key.as_ref()]);

        verify_ed25519_precompile(
            &ctx.accounts.instructions_sysvar,
            ed25519_ix_index,
            &authority,
            &digest,
        )?;

        // Drain the vault PDA's SOL to close_to before the state PDA closes.
        // System-owned account => use SystemProgram.transfer signed by vault seeds.
        let vault_lamports = ctx.accounts.vault.lamports();
        if vault_lamports > 0 {
            let ix = system_instruction::transfer(
                &ctx.accounts.vault.key(),
                &close_to_key,
                vault_lamports,
            );
            invoke_signed(
                &ix,
                &[
                    ctx.accounts.vault.to_account_info(),
                    ctx.accounts.close_to.to_account_info(),
                    ctx.accounts.system_program.to_account_info(),
                ],
                &[&[VAULT_SEED, authority.as_ref(), &[vault_bump]]],
            )?;
        }

        // Anchor's `close = close_to` constraint sweeps state PDA's rent.
        Ok(())
    }
}

// ── State ─────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct VectorAccount {
    pub authority: Pubkey,
    pub seed: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

// ── Accounts ──────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: only used for PDA derivation; not a signer here. The cold
    /// wallet authorizes future actions through Ed25519 signatures, not by
    /// signing the init transaction.
    pub authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = payer,
        space = 8 + VectorAccount::INIT_SPACE,
        seeds = [VECTOR_SEED, authority.key().as_ref()],
        bump,
    )]
    pub vector: Account<'info, VectorAccount>,

    /// CHECK: derivation-checked. Stays system-owned and may not yet exist —
    /// it becomes a real on-chain account once SOL is sent to it. Storing
    /// the bump here at init time avoids find_program_address at execute.
    #[account(
        seeds = [VAULT_SEED, authority.key().as_ref()],
        bump,
    )]
    pub vault: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Execute<'info> {
    #[account(
        mut,
        seeds = [VECTOR_SEED, vector.authority.as_ref()],
        bump = vector.bump,
    )]
    pub vector: Account<'info, VectorAccount>,

    /// CHECK: address-checked against the sysvar program ID.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
    // Sub-instruction programs + accounts go in ctx.remaining_accounts,
    // in the order specified by sub_ix_data.
}

#[derive(Accounts)]
pub struct CloseVector<'info> {
    #[account(
        mut,
        close = close_to,
        seeds = [VECTOR_SEED, vector.authority.as_ref()],
        bump = vector.bump,
    )]
    pub vector: Account<'info, VectorAccount>,

    /// CHECK: derivation-checked; lamports drained via SystemProgram CPI.
    #[account(
        mut,
        seeds = [VAULT_SEED, vector.authority.as_ref()],
        bump = vector.vault_bump,
    )]
    pub vault: UncheckedAccount<'info>,

    /// CHECK: address-checked against the sysvar program ID.
    #[account(address = IX_SYSVAR_ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,

    /// CHECK: rent destination. Cold wallet authorizes this address by
    /// including its bytes in the signed digest.
    #[account(mut)]
    pub close_to: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ── Helpers ───────────────────────────────────────────────────────────

fn verify_ed25519_precompile(
    instructions_sysvar: &UncheckedAccount,
    ed25519_ix_index: u8,
    expected_pubkey: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let sysvar_ai = instructions_sysvar.to_account_info();
    let current_ix_index =
        load_current_index_checked(&sysvar_ai).map_err(|_| error!(VectorError::SysvarLoadFailed))?;

    // Precompile must appear strictly before our instruction.
    require!(
        (ed25519_ix_index as u16) < current_ix_index,
        VectorError::PrecompileIndexOutOfBounds
    );

    let precompile_ix = load_instruction_at_checked(ed25519_ix_index as usize, &sysvar_ai)
        .map_err(|_| error!(VectorError::SysvarLoadFailed))?;

    require!(
        precompile_ix.program_id == ED25519_PROGRAM_ID,
        VectorError::NotEd25519Precompile
    );

    let data = &precompile_ix.data;
    require!(
        data.len() >= ED25519_MIN_DATA_LEN,
        VectorError::PrecompileDataTooShort
    );

    // Exactly one signature.
    require!(data[0] == 1, VectorError::WrongSignatureCount);

    // Parse the 14-byte offsets struct (after num_sigs + pad).
    let off = &data[2..16];
    let signature_offset = u16::from_le_bytes([off[0], off[1]]) as usize;
    let signature_ix_index = u16::from_le_bytes([off[2], off[3]]);
    let pubkey_offset = u16::from_le_bytes([off[4], off[5]]) as usize;
    let pubkey_ix_index = u16::from_le_bytes([off[6], off[7]]);
    let message_offset = u16::from_le_bytes([off[8], off[9]]) as usize;
    let message_size = u16::from_le_bytes([off[10], off[11]]) as usize;
    let message_ix_index = u16::from_le_bytes([off[12], off[13]]);

    // We require all data to live inside the precompile's own data
    // (instruction_index = 0xFFFF means "self"). Cross-instruction data
    // references would let an attacker swap the message for our digest.
    require!(
        signature_ix_index == SELF_REF
            && pubkey_ix_index == SELF_REF
            && message_ix_index == SELF_REF,
        VectorError::PrecompileDataInOtherIx
    );

    require!(message_size == 32, VectorError::WrongMessageLength);

    require!(
        signature_offset
            .checked_add(ED25519_SIG_LEN)
            .map(|e| e <= data.len())
            .unwrap_or(false)
            && pubkey_offset
                .checked_add(ED25519_PUBKEY_LEN)
                .map(|e| e <= data.len())
                .unwrap_or(false)
            && message_offset
                .checked_add(message_size)
                .map(|e| e <= data.len())
                .unwrap_or(false),
        VectorError::PrecompileDataTooShort
    );

    let pubkey_bytes = &data[pubkey_offset..pubkey_offset + ED25519_PUBKEY_LEN];
    require!(
        pubkey_bytes == expected_pubkey.as_ref(),
        VectorError::WrongPubkey
    );

    let message_bytes = &data[message_offset..message_offset + 32];
    require!(
        message_bytes == expected_message.as_slice(),
        VectorError::WrongMessage
    );

    Ok(())
}

#[derive(Clone)]
struct DecodedSubIx {
    program_id: Pubkey,
    accounts: Vec<SubAccount>,
    data: Vec<u8>,
}

#[derive(Clone)]
struct SubAccount {
    pubkey: Pubkey,
    is_writable: bool,
    is_signer: bool,
}

// Wire format:
//   [u8 num_ixs]
//   per ix:
//     [Pubkey program_id (32B)]
//     [u8 num_accounts]
//     per account:
//       [Pubkey (32B)]
//       [u8 flags]   bit0 = is_writable, bit1 = is_signer
//     [u16 LE data_len]
//     [data]
fn decode_sub_instructions(data: &[u8]) -> Result<Vec<DecodedSubIx>> {
    let mut cur = 0usize;
    require!(!data.is_empty(), VectorError::SubIxDecodeError);
    let num_ixs = data[cur] as usize;
    cur += 1;

    let mut out = Vec::with_capacity(num_ixs);
    for _ in 0..num_ixs {
        require!(cur + 32 <= data.len(), VectorError::SubIxDecodeError);
        let program_id =
            Pubkey::new_from_array(data[cur..cur + 32].try_into().unwrap());
        cur += 32;

        require!(cur + 1 <= data.len(), VectorError::SubIxDecodeError);
        let num_accs = data[cur] as usize;
        cur += 1;

        let mut accounts = Vec::with_capacity(num_accs);
        for _ in 0..num_accs {
            require!(cur + 33 <= data.len(), VectorError::SubIxDecodeError);
            let pk =
                Pubkey::new_from_array(data[cur..cur + 32].try_into().unwrap());
            let flags = data[cur + 32];
            cur += 33;
            accounts.push(SubAccount {
                pubkey: pk,
                is_writable: (flags & 0x01) != 0,
                is_signer: (flags & 0x02) != 0,
            });
        }

        require!(cur + 2 <= data.len(), VectorError::SubIxDecodeError);
        let data_len = u16::from_le_bytes([data[cur], data[cur + 1]]) as usize;
        cur += 2;

        require!(cur + data_len <= data.len(), VectorError::SubIxDecodeError);
        let ix_data = data[cur..cur + data_len].to_vec();
        cur += data_len;

        out.push(DecodedSubIx {
            program_id,
            accounts,
            data: ix_data,
        });
    }
    require!(cur == data.len(), VectorError::SubIxDecodeError);
    Ok(out)
}

fn execute_sub_instructions(
    sub_ixs: &[DecodedSubIx],
    remaining: &[AccountInfo],
    authority: &Pubkey,
    vault_bump: u8,
) -> Result<()> {
    let (vault_pda, _) =
        Pubkey::find_program_address(&[VAULT_SEED, authority.as_ref()], &crate::ID);
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, authority.as_ref(), &[vault_bump]];

    let mut cursor = 0usize;
    for sub_ix in sub_ixs {
        // Program AccountInfo first.
        require!(cursor < remaining.len(), VectorError::MissingAccount);
        let program_ai = &remaining[cursor];
        require!(
            program_ai.key == &sub_ix.program_id,
            VectorError::AccountMismatch
        );
        cursor += 1;

        let mut metas = Vec::with_capacity(sub_ix.accounts.len());
        let mut infos: Vec<AccountInfo> = Vec::with_capacity(sub_ix.accounts.len() + 1);
        infos.push(program_ai.clone());

        for sub_acc in &sub_ix.accounts {
            require!(cursor < remaining.len(), VectorError::MissingAccount);
            let acc_ai = &remaining[cursor];
            require!(
                acc_ai.key == &sub_acc.pubkey,
                VectorError::AccountMismatch
            );
            cursor += 1;

            // Only the Vault PDA can be a signer in a sub-instruction —
            // its signature comes from invoke_signed below. Any other
            // "is_signer = true" would require a tx-level signer for an
            // account the cold wallet doesn't control.
            if sub_acc.is_signer {
                require!(
                    sub_acc.pubkey == vault_pda,
                    VectorError::NonPdaSignerInSubIx
                );
            }

            metas.push(AccountMeta {
                pubkey: sub_acc.pubkey,
                is_signer: sub_acc.is_signer,
                is_writable: sub_acc.is_writable,
            });
            infos.push(acc_ai.clone());
        }

        let ix = Instruction {
            program_id: sub_ix.program_id,
            accounts: metas,
            data: sub_ix.data.clone(),
        };

        invoke_signed(&ix, &infos, &[signer_seeds]).map_err(|e| {
            msg!("Sub-instruction CPI failed: {:?}", e);
            error!(VectorError::CpiFailed)
        })?;
    }

    require!(cursor == remaining.len(), VectorError::ExtraAccounts);
    Ok(())
}

// ── Errors ────────────────────────────────────────────────────────────

#[error_code]
pub enum VectorError {
    #[msg("Failed to load instructions sysvar")]
    SysvarLoadFailed,
    #[msg("Ed25519 precompile index out of bounds (must be before this instruction)")]
    PrecompileIndexOutOfBounds,
    #[msg("Instruction at given index is not the Ed25519 precompile")]
    NotEd25519Precompile,
    #[msg("Precompile data too short")]
    PrecompileDataTooShort,
    #[msg("Expected exactly one signature in the precompile")]
    WrongSignatureCount,
    #[msg("Precompile signature/key/message must be embedded in the precompile's own data")]
    PrecompileDataInOtherIx,
    #[msg("Precompile message is not 32 bytes")]
    WrongMessageLength,
    #[msg("Pubkey signed by the precompile does not match the Vector authority")]
    WrongPubkey,
    #[msg("Message signed by the precompile does not match the expected digest")]
    WrongMessage,
    #[msg("Failed to decode sub-instruction data")]
    SubIxDecodeError,
    #[msg("Missing account in remaining_accounts for sub-instruction")]
    MissingAccount,
    #[msg("Account in remaining_accounts does not match sub-instruction spec")]
    AccountMismatch,
    #[msg("Sub-instruction signer must be the Vault PDA")]
    NonPdaSignerInSubIx,
    #[msg("Sub-instruction CPI failed")]
    CpiFailed,
    #[msg("Extra accounts in remaining_accounts not consumed by sub-instructions")]
    ExtraAccounts,
}
