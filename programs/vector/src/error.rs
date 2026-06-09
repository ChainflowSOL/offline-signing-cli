use anchor_lang::prelude::*;

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
