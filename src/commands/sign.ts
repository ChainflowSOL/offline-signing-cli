import { Keypair, VersionedMessage } from "@solana/web3.js";
import * as fs from "fs";
import nacl from "tweetnacl";
import * as readline from "readline";
import { loadJson, saveJson, UnsignedTxJson } from "../utils/io";

export async function signOffline(keypairPath: string, unsignedPath: string) {
    // 1. Load Cold Wallet Keypair
    if (!fs.existsSync(keypairPath)) {
        throw new Error(`Cold wallet file not found at: ${keypairPath}`);
    }
    
    const keypairContent = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
    const secretKey = Array.isArray(keypairContent) 
        ? Uint8Array.from(keypairContent) 
        : new Uint8Array(Object.values(keypairContent._keypair?.secretKey || keypairContent));
        
    const keypair: Keypair = Keypair.fromSecretKey(secretKey);

    // 2. Load V0 Message
    const txData: UnsignedTxJson = loadJson<UnsignedTxJson>(unsignedPath);
    const messageBuffer = Buffer.from(txData.messageBase64, "base64");
    const message: VersionedMessage = VersionedMessage.deserialize(messageBuffer);
    
    // 3. Verification logs for the user
    console.log("╔═════════════════════════════════════════════╗");
    console.log("║           OFFLINE SIGNING REQUEST           ║");
    console.log("╚═════════════════════════════════════════════╝");
    console.log(`\nNetwork: ${txData.network.toUpperCase()}`);
    console.log(`  Signer:  ${keypair.publicKey.toBase58()}`);
    console.log("-------------------------------------------------------");
    
    if (txData.meta) {
        console.log(`  Action:   TRANSFER`);
        console.log(`  Amount:   ${txData.meta.amount} ${txData.meta.tokenSymbol}`);
    } else {
        console.log(` Description:  ${txData.description}`);
    }

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });

    const answer = await new Promise<string>(resolve => {
        rl.question('\nCONFIRM: Type "yes" to sign this transaction: ', resolve);
    });

    rl.close();

    if (answer.trim().toLowerCase() !== 'yes') {
        console.log("\nABORTED: Transaction was NOT signed.");
        return;
    }

    // 4. Sign and Save
    const signature = nacl.sign.detached(messageBuffer, keypair.secretKey);
    const signatureBase64 = Buffer.from(signature).toString("base64");
    
    saveJson("signed-tx.json", {
        signature: signatureBase64,
        publicKey: keypair.publicKey.toBase58()
    });
    
    console.log(`NEXT STEP: Move 'signature.json' back to your ONLINE machine and run 'broadcast'.`);
}