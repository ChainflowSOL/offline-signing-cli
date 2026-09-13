// Devnet setup for the token-transfer test: create a mint, create the vault's
// ATA, mint tokens into it. Prints the mint so the CLI test can use it.
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddress,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import { findVaultPda } from "../src/utils/vector";

// Usage: setup-mint.ts <COLD_PUBKEY> [devnet|mainnet|<rpc-url>]
function rpcFor(env: string): string {
  if (env === "devnet") return "https://api.devnet.solana.com";
  if (env === "mainnet" || env === "mainnet-beta")
    return "https://api.mainnet-beta.solana.com";
  return env;
}

async function main() {
  const coldStr = process.argv[2];
  if (!coldStr) throw new Error("usage: setup-mint.ts <COLD_PUBKEY> [cluster]");
  const conn = new Connection(rpcFor(process.argv[3] ?? "devnet"), "confirmed");
  const payer = Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))
    )
  );
  const cold = new PublicKey(coldStr);
  const [vault] = findVaultPda(cold);

  const mintKp = Keypair.generate();
  const lamports = await getMinimumBalanceForRentExemptMint(conn);
  const vaultAta = await getAssociatedTokenAddress(mintKp.publicKey, vault, true);

  const tx = new Transaction()
    .add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: mintKp.publicKey,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_PROGRAM_ID,
      })
    )
    .add(
      createInitializeMint2Instruction(mintKp.publicKey, 6, payer.publicKey, null)
    )
    .add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vaultAta,
        vault,
        mintKp.publicKey
      )
    )
    .add(
      createMintToInstruction(
        mintKp.publicKey,
        vaultAta,
        payer.publicKey,
        10_000_000 // 10 tokens at 6 decimals
      )
    );

  const sig = await sendAndConfirmTransaction(conn, tx, [payer, mintKp], {
    commitment: "confirmed",
  });

  fs.writeFileSync("smoke/.mint-v2", mintKp.publicKey.toBase58());
  console.log("MINT=" + mintKp.publicKey.toBase58());
  console.log("VAULT_ATA=" + vaultAta.toBase58());
  console.log("tx=" + sig);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
