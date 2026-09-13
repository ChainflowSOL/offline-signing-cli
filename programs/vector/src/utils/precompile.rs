use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{
    load_current_index_checked, load_instruction_at_checked,
};

use crate::constants::*;
use crate::error::VectorError;

pub fn verify_ed25519_precompile(
    instructions_sysvar: &UncheckedAccount,
    ed25519_ix_index: u8,
    expected_pubkey: &Pubkey,
    expected_message: &[u8; 32],
) -> Result<()> {
    let sysvar_ai = instructions_sysvar.to_account_info();
    let current_ix_index = load_current_index_checked(&sysvar_ai)
        .map_err(|_| error!(VectorError::SysvarLoadFailed))?;

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
