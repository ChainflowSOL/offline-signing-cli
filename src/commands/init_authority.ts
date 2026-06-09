import {
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import * as fs from "fs";
import { getConnection } from "../utils/connection";
import { saveJson } from "../utils/io";
import {
  buildInitializeInstruction,
  findVaultPda,
  findVectorPda,
} from "../utils/vector";

export async function initAuthority(
  env: string,
  payerKeypairPath: string,
  coldAddressStr: string
): Promise<void> {
  const connection = getConnection(env);

  if (!fs.existsSync(payerKeypairPath)) {
    throw new Error(`Hot-wallet keypair not found at: ${payerKeypairPath}`);
  }
  const payerSecret = new Uint8Array(
    JSON.parse(fs.readFileSync(payerKeypairPath, "utf-8"))
  );
  const payer: Keypair = Keypair.fromSecretKey(payerSecret);

  const authority = new PublicKey(coldAddressStr);
  const [vectorPda, bump] = findVectorPda(authority);
  const [vaultPda, vaultBump] = findVaultPda(authority);

  console.log(`\nInitializing Vector PDA on ${env.toUpperCase()}`);
  console.log(`  Payer (Hot):   ${payer.publicKey.toBase58()}`);
  console.log(`  Authority:     ${authority.toBase58()}  (cold wallet)`);
  console.log(`  Vector PDA:    ${vectorPda.toBase58()}  (state, bump=${bump})`);
  console.log(`  Vault PDA:     ${vaultPda.toBase58()}  (funds, bump=${vaultBump})`);

  const existing = await connection.getAccountInfo(vectorPda);
  if (existing) {
    console.log(`\nVector PDA already exists. Skipping initialize.`);
    saveJson("vector-info.json", {
      authority: authority.toBase58(),
      vectorPda: vectorPda.toBase58(),
      vaultPda: vaultPda.toBase58(),
      network: env,
    });
    return;
  }

  const tx = new Transaction().add(
    buildInitializeInstruction(payer.publicKey, authority)
  );

  const txid = await connection.sendTransaction(tx, [payer]);
  console.log(`\nInitialize submitted. Tx: ${txid}`);
  await connection.confirmTransaction(txid, "confirmed");
  console.log("Confirmed.");

  saveJson("vector-info.json", {
    authority: authority.toBase58(),
    vectorPda: vectorPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    network: env,
  });

  console.log(`\nNEXT STEPS:`);
  console.log(`  1. Fund the Vault PDA (${vaultPda.toBase58()}) with SOL / SPL tokens.`);
  console.log(`     (SPL ATAs should be created with the Vault PDA as owner, off-curve.)`);
  console.log(`  2. Use 'sol-transfer' or 'token-transfer' to spend from the Vault PDA.`);
}
