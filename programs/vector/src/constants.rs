use anchor_lang::prelude::*;

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
