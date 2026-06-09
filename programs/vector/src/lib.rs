use anchor_lang::prelude::*;

declare_id!("DkKZTgUDgkqUu5tck69uQJKf1deNzSY7YcU8F47oLXPZ");

pub mod constants;
pub mod error;
pub mod state;
pub mod utils;

// Instruction modules — each owns its Accounts struct + handler. Anchor's
pub mod close;
pub mod execute;
pub mod initialize;

use close::*;
use execute::*;
use initialize::*;

#[program]
pub mod vector {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::initialize::handler(ctx)
    }

    pub fn execute(
        ctx: Context<Execute>,
        ed25519_ix_index: u8,
        sub_ix_data: Vec<u8>,
    ) -> Result<()> {
        crate::execute::handler(ctx, ed25519_ix_index, sub_ix_data)
    }

    pub fn close(ctx: Context<CloseVector>, ed25519_ix_index: u8) -> Result<()> {
        crate::close::handler(ctx, ed25519_ix_index)
    }
}
