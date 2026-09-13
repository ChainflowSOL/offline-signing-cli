import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMint,
} from "@solana/spl-token";
import { getConnection } from "../utils/connection";
import { getTokenSymbol } from "../utils/tokenSymbol";
import { saveJson, serializeInstruction, VectorExecuteTxV1 } from "../utils/io";
import {
  digestExecute,
  encodeSubInstructions,
  fetchVectorAccount,
  findVaultPda,
  findVectorPda,
} from "../utils/vector";

export async function constructTokenTransfer(
  env: string,
  coldAddressStr: string,
  recipientStr: string,
  mintStr: string,
  amount: number,
  payerStr: string
): Promise<void> {
  const connection = getConnection(env);
  const authority = new PublicKey(coldAddressStr);
  const recipient = new PublicKey(recipientStr);
  const mint = new PublicKey(mintStr);
  const feePayer = new PublicKey(payerStr);
  const [vectorPda] = findVectorPda(authority);
  const [vaultPda] = findVaultPda(authority);

  const mintInfo = await getMint(connection, mint);
  const tokenSymbol = await getTokenSymbol(connection, mint);
  const amountRaw = BigInt(Math.round(amount * Math.pow(10, mintInfo.decimals)));

  // Source ATA is owned by the Vault PDA (off-curve).
  const sourceATA = await getAssociatedTokenAddress(mint, vaultPda, true);
  const destATA = await getAssociatedTokenAddress(mint, recipient);

  console.log(`\nConstructing SPL Token Transfer on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vector PDA:   ${vectorPda.toBase58()}  (state)`);
  console.log(`  Vault PDA:    ${vaultPda.toBase58()}  (ATA owner)`);
  console.log(`  Mint:         ${mint.toBase58()}  (${tokenSymbol}, ${mintInfo.decimals} decimals)`);
  console.log(`  Source ATA:   ${sourceATA.toBase58()}`);
  console.log(`  Recipient:    ${recipient.toBase58()}`);
  console.log(`  Dest ATA:     ${destATA.toBase58()}`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);
  console.log(`  Amount:       ${amount} ${tokenSymbol}`);

  // Pre-check ATAs — but DO NOT include creation in the signed digest;
  // creation is fee-payer side, not authority-authorized. Hot wallet
  // creates the dest ATA as a pre-instruction in broadcast.ts if needed.
  const [sourceInfo] = await connection.getMultipleAccountsInfo([sourceATA]);
  if (!sourceInfo) {
    throw new Error(
      `Source ATA ${sourceATA.toBase58()} does not exist. ` +
        `Fund the Vector PDA with this mint first.`
    );
  }

  // The signed sub-instructions: just the SPL token transfer.
  // The PDA signs (via invoke_signed). We also surface the dest ATA address
  // so broadcast.ts can create it if missing.
  const transferIx: TransactionInstruction = createTransferInstruction(
    sourceATA,
    destATA,
    vaultPda,
    amountRaw
  );

  const subIxs: TransactionInstruction[] = [transferIx];
  const subIxData = encodeSubInstructions(subIxs);
  const seed = (await fetchVectorAccount(connection, authority)).seed;
  const digest = digestExecute(seed, subIxData);

  const payload: VectorExecuteTxV1 = {
    version: "vector-v1",
    action: "execute",
    description: `Transfer ${amount} ${tokenSymbol} to ${recipient.toBase58().slice(0, 8)}...`,
    network: env,
    coldAddress: authority.toBase58(),
    feePayer: feePayer.toBase58(),
    seedBase64: seed.toString("base64"),
    digestBase64: digest.toString("base64"),
    subInstructions: subIxs.map(serializeInstruction),
    meta: {
      tokenSymbol,
      decimals: mintInfo.decimals,
      amount,
      recipient: recipient.toBase58(),
    },
  };

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to your OFFLINE machine and run 'sign'.`);
}

// Used by broadcast.ts to decide whether to prepend an ATA-create.
export async function destAtaExists(
  connection: ReturnType<typeof getConnection>,
  destAta: PublicKey
): Promise<boolean> {
  const info = await connection.getAccountInfo(destAta);
  return info !== null;
}

export { createAssociatedTokenAccountInstruction, getAssociatedTokenAddress };
