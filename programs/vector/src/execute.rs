use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::ID as IX_SYSVAR_ID;

use crate::constants::*;
use crate::state::VectorAccount;
use crate::utils::hash::sha256;
use crate::utils::precompile::verify_ed25519_precompile;
use crate::utils::sub_instructions::{decode_sub_instructions, execute_sub_instructions};

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

pub fn handler(
    ctx: Context<Execute>,
    ed25519_ix_index: u8,
    sub_ix_data: Vec<u8>,
) -> Result<()> {
    let authority = ctx.accounts.vector.authority;
    let seed = ctx.accounts.vector.seed;
    let vault_bump = ctx.accounts.vector.vault_bump;

    // 1. Expected digest = sha256(seed || ACTION_EXECUTE || program_id || sub_ix_data)
    //    Binding crate::ID prevents a signature valid at one deployed program
    //    from ever being replayed against a different deployment (audit F5).
    let program_id_bytes = crate::ID.to_bytes();
    let digest = sha256(&[
        &seed,
        &[ACTION_EXECUTE],
        &program_id_bytes,
        &sub_ix_data,
    ]);

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
