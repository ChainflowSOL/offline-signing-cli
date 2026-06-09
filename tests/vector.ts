import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Ed25519Program,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
  Transaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAccount,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { expect } from "chai";
import nacl from "tweetnacl";
import {
  digestExecute,
  digestClose,
  encodeSubInstructions,
  fetchVectorAccount,
  findVaultPda,
  findVectorPda,
} from "../src/utils/vector";
import type { Vector } from "../target/types/vector";

describe("vector", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const provider = anchor.AnchorProvider.env();
  const program = anchor.workspace.vector as Program<Vector>;
  const connection = provider.connection;

  // Each test gets its own cold keypair (and therefore its own PDA) so they
  // can run independently in any order.
  function makeCold(): Keypair {
    return Keypair.generate();
  }

  // Returns [vectorPda, vaultPda].
  async function initialize(cold: Keypair): Promise<[PublicKey, PublicKey]> {
    const [vectorPda] = findVectorPda(cold.publicKey);
    const [vaultPda] = findVaultPda(cold.publicKey);
    await program.methods
      .initialize()
      .accounts({
        payer: provider.wallet.publicKey,
        authority: cold.publicKey,
      } as any)
      .rpc();
    return [vectorPda, vaultPda];
  }

  async function fundVault(vault: PublicKey, sol: number): Promise<void> {
    const sig = await connection.requestAirdrop(vault, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  // Build a transaction that executes a signed Vector action and send it.
  async function sendExecute(
    cold: Keypair,
    subIxs: TransactionInstruction[],
    preIxs: TransactionInstruction[] = [],
    options: {
      tamperDigest?: boolean;
      wrongSigner?: Keypair;
      omitPrecompile?: boolean;
    } = {}
  ): Promise<string> {
    const seed = (await fetchVectorAccount(connection, cold.publicKey)).seed;
    const subIxData = encodeSubInstructions(subIxs);
    let digest = digestExecute(seed, subIxData);
    if (options.tamperDigest) {
      digest = Buffer.from(digest);
      digest[0] ^= 0xff;
    }
    const signer = options.wrongSigner ?? cold;
    const signature = nacl.sign.detached(digest, signer.secretKey);

    const precompileIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: signer.publicKey.toBytes(),
      signature: Buffer.from(signature),
      message: digest,
    });

    const ed25519Index = options.omitPrecompile ? 99 : preIxs.length;

    const remaining: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    for (const ix of subIxs) {
      remaining.push({ pubkey: ix.programId, isSigner: false, isWritable: false });
      for (const meta of ix.keys) {
        remaining.push({
          pubkey: meta.pubkey,
          isSigner: false,
          isWritable: meta.isWritable,
        });
      }
    }

    const builder = program.methods
      .execute(ed25519Index, Buffer.from(subIxData))
      .accounts({
        vector: findVectorPda(cold.publicKey)[0],
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(remaining);

    const ixs: TransactionInstruction[] = [...preIxs];
    if (!options.omitPrecompile) ixs.push(precompileIx);
    ixs.push(await builder.instruction());

    const tx = new Transaction().add(...ixs);
    return await provider.sendAndConfirm(tx);
  }

  // ── tests ─────────────────────────────────────────────────────────

  it("initialize creates the PDA with correct authority and a nonzero seed", async () => {
    const cold = makeCold();
    const [vectorPda] = await initialize(cold);
    const acc = await fetchVectorAccount(connection, cold.publicKey);
    expect(acc.authority.toBase58()).to.equal(cold.publicKey.toBase58());
    expect(acc.seed.length).to.equal(32);
    expect(acc.seed.equals(Buffer.alloc(32))).to.equal(false);
    expect(vectorPda.toBase58()).to.equal(findVectorPda(cold.publicKey)[0].toBase58());
  });

  it("execute: SOL transfer happy path advances the seed", async () => {
    const cold = makeCold();
    const [, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    const recipient = Keypair.generate().publicKey;
    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: recipient,
      lamports: 0.25 * LAMPORTS_PER_SOL,
    });

    const before = await fetchVectorAccount(connection, cold.publicKey);
    await sendExecute(cold, [transferIx]);
    const after = await fetchVectorAccount(connection, cold.publicKey);

    expect(after.seed.equals(before.seed)).to.equal(false);
    const recipientBalance = await connection.getBalance(recipient);
    expect(recipientBalance).to.equal(0.25 * LAMPORTS_PER_SOL);
  });

  it("replay: re-broadcasting an old signature fails (seed has moved)", async () => {
    const cold = makeCold();
    const [vectorPda, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    const recipient = Keypair.generate().publicKey;
    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: recipient,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });

    // First call captures the (now-stale) seed.
    const staleSeed = (await fetchVectorAccount(connection, cold.publicKey)).seed;
    const subIxData = encodeSubInstructions([transferIx]);
    const staleDigest = digestExecute(staleSeed, subIxData);
    const staleSig = nacl.sign.detached(staleDigest, cold.secretKey);
    const stalePrecompile = Ed25519Program.createInstructionWithPublicKey({
      publicKey: cold.publicKey.toBytes(),
      signature: Buffer.from(staleSig),
      message: staleDigest,
    });

    // First send succeeds (seed advances).
    await sendExecute(cold, [transferIx]);

    // Now try to re-send the original ix with the stale precompile.
    const remaining = [
      { pubkey: transferIx.programId, isSigner: false, isWritable: false },
      ...transferIx.keys.map((k) => ({
        pubkey: k.pubkey,
        isSigner: false,
        isWritable: k.isWritable,
      })),
    ];
    const replayBuilder = program.methods
      .execute(0, Buffer.from(subIxData))
      .accounts({
        vector: vectorPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      } as any)
      .remainingAccounts(remaining);
    const replayTx = new Transaction().add(
      stalePrecompile,
      await replayBuilder.instruction()
    );

    let threw = false;
    try {
      await provider.sendAndConfirm(replayTx);
    } catch (e: any) {
      threw = true;
      const msg = (e?.toString() ?? "") + " " + (e?.logs?.join(" ") ?? "");
      expect(msg).to.match(/WrongMessage|0x1778/i); // 6008 = 0x1778
    }
    expect(threw, "replay should throw").to.equal(true);
  });

  it("execute: SPL token transfer through CPI", async () => {
    const cold = makeCold();
    const [, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    // Create a mint where provider.wallet is the mint authority.
    const mintKeypair = Keypair.generate();
    const lamports = await getMinimumBalanceForRentExemptMint(connection);
    const createMintTx = new Transaction()
      .add(
        SystemProgram.createAccount({
          fromPubkey: provider.wallet.publicKey,
          newAccountPubkey: mintKeypair.publicKey,
          space: MINT_SIZE,
          lamports,
          programId: TOKEN_PROGRAM_ID,
        })
      )
      .add(
        createInitializeMint2Instruction(
          mintKeypair.publicKey,
          6,
          provider.wallet.publicKey,
          null
        )
      );
    await provider.sendAndConfirm(createMintTx, [mintKeypair]);

    const sourceAta = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      vaultPda,
      true
    );
    const recipient = Keypair.generate().publicKey;
    const destAta = await getAssociatedTokenAddress(
      mintKeypair.publicKey,
      recipient
    );

    const setupTx = new Transaction()
      .add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          sourceAta,
          vaultPda,
          mintKeypair.publicKey
        )
      )
      .add(
        createAssociatedTokenAccountInstruction(
          provider.wallet.publicKey,
          destAta,
          recipient,
          mintKeypair.publicKey
        )
      )
      .add(
        createMintToInstruction(
          mintKeypair.publicKey,
          sourceAta,
          provider.wallet.publicKey,
          1_000_000 // 1.0 token at 6 decimals
        )
      );
    await provider.sendAndConfirm(setupTx);

    const transferIx = createTransferInstruction(
      sourceAta,
      destAta,
      vaultPda,
      500_000n
    );
    await sendExecute(cold, [transferIx]);

    const destAccount = await getAccount(connection, destAta);
    expect(destAccount.amount.toString()).to.equal("500000");
  });

  it("close: succeeds, drains vault, refunds rent to close_to", async () => {
    const cold = makeCold();
    const [vectorPda, vaultPda] = await initialize(cold);
    // Put some SOL in the vault so we can verify it gets drained on close.
    await fundVault(vaultPda, 0.5);

    const closeTo = Keypair.generate();
    const seed = (await fetchVectorAccount(connection, cold.publicKey)).seed;
    const digest = digestClose(seed, closeTo.publicKey);
    const signature = nacl.sign.detached(digest, cold.secretKey);

    const precompileIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: cold.publicKey.toBytes(),
      signature: Buffer.from(signature),
      message: digest,
    });

    const closeBuilder = program.methods
      .close(0)
      .accounts({
        vector: vectorPda,
        vault: vaultPda,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
        closeTo: closeTo.publicKey,
      } as any);

    const tx = new Transaction().add(precompileIx, await closeBuilder.instruction());
    await provider.sendAndConfirm(tx);

    // State PDA gone
    const stateInfo = await connection.getAccountInfo(vectorPda);
    expect(stateInfo).to.equal(null);

    // Vault drained to 0 (and therefore garbage-collected by runtime)
    const vaultBal = await connection.getBalance(vaultPda);
    expect(vaultBal).to.equal(0);

    // close_to received state PDA's rent + vault's 0.5 SOL
    const closeToBal = await connection.getBalance(closeTo.publicKey);
    expect(closeToBal).to.be.greaterThan(0.5 * LAMPORTS_PER_SOL);
  });

  it("adversarial: signature from a different keypair is rejected", async () => {
    const cold = makeCold();
    const [, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    const attacker = Keypair.generate();
    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: Keypair.generate().publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });

    let threw = false;
    try {
      await sendExecute(cold, [transferIx], [], { wrongSigner: attacker });
    } catch (e: any) {
      threw = true;
      const msg = (e?.toString() ?? "") + " " + (e?.logs?.join(" ") ?? "");
      // Either the precompile itself rejects the bad signature, or the
      // program rejects the wrong-pubkey check (6007).
      expect(msg).to.match(/WrongPubkey|0x1777|invalid signature|Precompile/i);
    }
    expect(threw, "wrong signer should be rejected").to.equal(true);
  });

  it("adversarial: tampered digest is rejected", async () => {
    const cold = makeCold();
    const [, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: Keypair.generate().publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });

    let threw = false;
    try {
      await sendExecute(cold, [transferIx], [], { tamperDigest: true });
    } catch (e: any) {
      threw = true;
      const msg = (e?.toString() ?? "") + " " + (e?.logs?.join(" ") ?? "");
      // Tampered digest no longer matches the signed bytes — precompile
      // signature check fails, OR our message-equality check fails.
      expect(msg).to.match(/WrongMessage|0x1778|invalid signature|Precompile/i);
    }
    expect(threw, "tampered digest should be rejected").to.equal(true);
  });

  it("adversarial: missing Ed25519 precompile is rejected", async () => {
    const cold = makeCold();
    const [, vaultPda] = await initialize(cold);
    await fundVault(vaultPda, 1);

    const transferIx = SystemProgram.transfer({
      fromPubkey: vaultPda,
      toPubkey: Keypair.generate().publicKey,
      lamports: 0.1 * LAMPORTS_PER_SOL,
    });

    let threw = false;
    try {
      await sendExecute(cold, [transferIx], [], { omitPrecompile: true });
    } catch (e: any) {
      threw = true;
      const msg = (e?.toString() ?? "") + " " + (e?.logs?.join(" ") ?? "");
      expect(msg).to.match(
        /PrecompileIndexOutOfBounds|NotEd25519Precompile|SysvarLoadFailed|0x1771|0x1772|0x1770/i
      );
    }
    expect(threw, "missing precompile should be rejected").to.equal(true);
  });
});

// Suppress unused-import warning for BN
void BN;
