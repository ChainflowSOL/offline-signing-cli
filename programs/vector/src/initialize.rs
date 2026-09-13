use anchor_lang::prelude::*;

use crate::constants::*;
use crate::state::VectorAccount;
use crate::utils::hash::sha256;

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

pub fn handler(ctx: Context<Initialize>) -> Result<()> {
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
