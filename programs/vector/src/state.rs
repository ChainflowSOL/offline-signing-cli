use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct VectorAccount {
    pub authority: Pubkey,
    pub seed: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}
