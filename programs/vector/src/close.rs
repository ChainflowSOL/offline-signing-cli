use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    program::invoke_signed, system_instruction,
    sysvar::instructions::ID as IX_SYSVAR_ID,
};

use crate::constants::*;
use crate::state::VectorAccount;
use crate::utils::hash::sha256;
use crate::utils::precompile::verify_ed25519_precompile;

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

pub fn handler(ctx: Context<CloseVector>, ed25519_ix_index: u8) -> Result<()> {
    let vector = &ctx.accounts.vector;
    let close_to_key = ctx.accounts.close_to.key();
    let authority = vector.authority;
    let vault_bump = vector.vault_bump;

    // digest = sha256(seed || ACTION_CLOSE || program_id || close_to)
    // program_id binding prevents cross-deployment signature reuse (audit F5).
    let program_id_bytes = crate::ID.to_bytes();
    let digest = sha256(&[
        &vector.seed,
        &[ACTION_CLOSE],
        &program_id_bytes,
        close_to_key.as_ref(),
    ]);

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
