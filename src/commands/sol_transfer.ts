import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { getConnection } from "../utils/connection";
import { saveJson, serializeInstruction, VectorExecuteTxV1 } from "../utils/io";
import {
  digestExecute,
  encodeSubInstructions,
  fetchVectorAccount,
  findVaultPda,
  findVectorPda,
} from "../utils/vector";

export async function constructSolTransfer(
  env: string,
  coldAddressStr: string,
  recipientStr: string,
  payerStr: string,
  amount: number
): Promise<void> {
  const connection = getConnection(env);
  const authority = new PublicKey(coldAddressStr);
  const recipient = new PublicKey(recipientStr);
  const feePayer = new PublicKey(payerStr);
  const [vectorPda] = findVectorPda(authority);
  const [vaultPda] = findVaultPda(authority);

  console.log(`\nConstructing SOL Transfer on ${env.toUpperCase()}`);
  console.log(`  Authority:   ${authority.toBase58()}`);
  console.log(`  Vector PDA:  ${vectorPda.toBase58()}  (state)`);
  console.log(`  Vault PDA:   ${vaultPda.toBase58()}  (source of funds)`);
  console.log(`  Recipient:   ${recipient.toBase58()}`);
  console.log(`  Fee Payer:   ${feePayer.toBase58()}`);
  console.log(`  Amount:      ${amount} SOL`);

  // Fetch current seed — the digest is bound to it for replay protection.
  console.log(`\nFetching Vector seed...`);
  const vectorAccount = await fetchVectorAccount(connection, authority);

  // Sub-instruction: SystemProgram.transfer signed by the Vault PDA.
  const transferIx: TransactionInstruction = SystemProgram.transfer({
    fromPubkey: vaultPda,
    toPubkey: recipient,
    lamports: Math.round(amount * LAMPORTS_PER_SOL),
  });

  const subIxs: TransactionInstruction[] = [transferIx];
  const subIxData = encodeSubInstructions(subIxs);
  const digest = digestExecute(vectorAccount.seed, subIxData);

  const payload: VectorExecuteTxV1 = {
    version: "vector-v1",
    action: "execute",
    description: `Transfer ${amount} SOL to ${recipient.toBase58().slice(0, 8)}...`,
    network: env,
    coldAddress: authority.toBase58(),
    feePayer: feePayer.toBase58(),
    seedBase64: vectorAccount.seed.toString("base64"),
    digestBase64: digest.toString("base64"),
    subInstructions: subIxs.map(serializeInstruction),
    meta: {
      tokenSymbol: "SOL",
      decimals: 9,
      amount,
      recipient: recipient.toBase58(),
    },
  };

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to your OFFLINE machine and run 'sign'.`);
}
