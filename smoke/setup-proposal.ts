// Creates a proposal in the test realm and signs it off so it enters Voting
// state. Done entirely with hot-wallet signing — only the vote itself goes
// through the offline flow.
//
// Usage: pnpm exec ts-node smoke/setup-proposal.ts

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getGovernance,
  getProposal,
  PROGRAM_VERSION_V3,
  VoteType,
  withCreateProposal,
  withSignOffProposal,
} from "@solana/spl-governance";
import * as fs from "fs";

async function main() {
  const info = JSON.parse(fs.readFileSync("smoke/.realm-info.json", "utf8"));
  const conn = new Connection("https://api.devnet.solana.com", "confirmed");
  const payer = Keypair.fromSecretKey(
    new Uint8Array(
      JSON.parse(fs.readFileSync(`${process.env.HOME}/.config/solana/id.json`, "utf-8"))
    )
  );

  const gov = new PublicKey(info.governanceProgram);
  const realm = new PublicKey(info.realm);
  const governance = new PublicKey(info.governance);
  const mint = new PublicKey(info.mint);
  const hotTor = new PublicKey(info.hotTokenOwnerRecord);

  const govAcc = await getGovernance(conn, governance);
  const proposalIndex = govAcc.account.proposalCount;

  const ixs: TransactionInstruction[] = [];
  const proposal = await withCreateProposal(
    ixs,
    gov,
    PROGRAM_VERSION_V3,
    realm,
    governance,
    hotTor,
    "Vector offline-signing test proposal",
    "",
    mint,
    payer.publicKey, // governance authority = hot wallet (owner of hotTor)
    proposalIndex,
    VoteType.SINGLE_CHOICE,
    ["Approve"],
    true, // useDenyOption -> yes/no proposal
    payer.publicKey
  );

  // Sign off immediately so it moves Draft -> Voting.
  withSignOffProposal(
    ixs,
    gov,
    PROGRAM_VERSION_V3,
    realm,
    governance,
    proposal,
    payer.publicKey, // signatory
    undefined, // no separate signatory record
    hotTor // proposal owner record
  );

  const tx = new Transaction().add(...ixs);
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], {
    commitment: "confirmed",
  });

  const p = await getProposal(conn, proposal);
  console.log("PROPOSAL=" + proposal.toBase58());
  console.log("state=" + p.account.state);
  console.log("tx=" + sig);

  info.proposal = proposal.toBase58();
  fs.writeFileSync("smoke/.realm-info.json", JSON.stringify(info, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
