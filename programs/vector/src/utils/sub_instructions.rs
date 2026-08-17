use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::constants::*;
use crate::error::VectorError;

#[derive(Clone)]
pub struct DecodedSubIx {
    pub program_id: Pubkey,
    pub accounts: Vec<SubAccount>,
    pub data: Vec<u8>,
}

#[derive(Clone)]
pub struct SubAccount {
    pub pubkey: Pubkey,
    pub is_writable: bool,
    pub is_signer: bool,
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
pub fn decode_sub_instructions(data: &[u8]) -> Result<Vec<DecodedSubIx>> {
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

pub fn execute_sub_instructions(
    sub_ixs: &[DecodedSubIx],
    remaining: &[AccountInfo],
    authority: &Pubkey,
    vault_bump: u8,
    co_signer: Option<Pubkey>,
) -> Result<()> {
    // Derive the vault PDA from the stored bump instead of re-scanning with
    // find_program_address. The bump was persisted at init (canonical), and
    // invoke_signed below re-derives the address from these same seeds, so a
    // wrong bump could never yield a valid signer — this only saves compute.
    let vault_pda = Pubkey::create_program_address(
        &[VAULT_SEED, authority.as_ref(), &[vault_bump]],
        &crate::ID,
    )
    .map_err(|_| error!(VectorError::AccountMismatch))?;
    let signer_seeds: &[&[u8]] = &[VAULT_SEED, authority.as_ref(), &[vault_bump]];

    let mut cursor = 0usize;
    for sub_ix in sub_ixs {
        // Defense-in-depth: forbid the vault PDA from re-entering this program.
        // A self-CPI would run against the not-yet-advanced seed (execute.rs
        // advances the seed only after this function returns), which could let
        // an attacker bundle multiple same-seed authorizations in one tx. No
        // legitimate flow calls the Vector program recursively.
        require!(sub_ix.program_id != crate::ID, VectorError::SelfCpiForbidden);

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

            // Signers inside a sub-instruction are limited to:
            //   1. the Vault PDA — signed here via invoke_signed, and
            //   2. the optional co-signer, which Anchor has already proven
            //      signed the transaction.
            // Both pubkeys come from `sub_ix_data`, which is bound into the
            // cold-signed digest, so a broadcaster can neither add a signer nor
            // swap which account fills the co-signer slot.
            if sub_acc.is_signer {
                let is_vault = sub_acc.pubkey == vault_pda;
                let is_co_signer = co_signer == Some(sub_acc.pubkey);
                require!(
                    is_vault || is_co_signer,
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
