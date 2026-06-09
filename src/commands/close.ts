import { PublicKey } from "@solana/web3.js";
import { getConnection } from "../utils/connection";
import { saveJson, VectorCloseTxV1 } from "../utils/io";
import { digestClose, fetchVectorAccount, findVectorPda } from "../utils/vector";

export async function constructClose(
  env: string,
  coldAddressStr: string,
  closeToStr: string,
  payerStr: string
): Promise<void> {
  const connection = getConnection(env);
  const authority = new PublicKey(coldAddressStr);
  const closeTo = new PublicKey(closeToStr);
  const feePayer = new PublicKey(payerStr);
  const [vectorPda] = findVectorPda(authority);

  console.log(`\nConstructing Close on ${env.toUpperCase()}`);
  console.log(`  Authority:    ${authority.toBase58()}`);
  console.log(`  Vector PDA:   ${vectorPda.toBase58()}`);
  console.log(`  Rent → :      ${closeTo.toBase58()}`);
  console.log(`  Fee Payer:    ${feePayer.toBase58()}`);

  const seed = (await fetchVectorAccount(connection, authority)).seed;
  const digest = digestClose(seed, closeTo);

  const payload: VectorCloseTxV1 = {
    version: "vector-v1",
    action: "close",
    description: `Close Vector PDA; rent → ${closeTo.toBase58().slice(0, 8)}...`,
    network: env,
    coldAddress: authority.toBase58(),
    feePayer: feePayer.toBase58(),
    digestBase64: digest.toString("base64"),
    closeTo: closeTo.toBase58(),
  };

  saveJson("unsigned-tx.json", payload);
  console.log(`\nNEXT STEP: Copy 'unsigned-tx.json' to your OFFLINE machine and run 'sign'.`);
}
