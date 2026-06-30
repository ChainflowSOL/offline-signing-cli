#!/usr/bin/env node

/*
 * Copyright 2025 ChainflowSol
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 */

import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAuthority } from "./commands/init_authority";
import { constructSolTransfer } from "./commands/sol_transfer";
import { constructTokenTransfer } from "./commands/token_transfer";
import { constructClose } from "./commands/close";
import {
  constructStakeCreate,
  constructStakeDelegate,
  constructStakeDeactivate,
  constructStakeWithdraw,
} from "./commands/stake";
import { signOffline } from "./commands/sign";
import { broadcast } from "./commands/broadcast";

yargs(hideBin(process.argv))
  .scriptName("offline-signer")
  .option("env", {
    alias: "e",
    type: "string",
    description: "Network: devnet | mainnet | <custom-rpc-url>",
    default: "devnet",
    global: true,
  })
  .command(
    "init-authority",
    "Initialize the Vector PDA for a cold-wallet pubkey",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true, description: "Cold-wallet pubkey" })
        .option("payer", { alias: "p", type: "string", default: "hot-wallet.json", description: "Hot-wallet keypair path" }),
    (argv) =>
      initAuthority(argv.env as string, argv.payer as string, argv.cold as string)
  )
  .command(
    "sol-transfer",
    "Build an unsigned SOL transfer from the Vector PDA",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("recipient", { alias: "r", type: "string", demandOption: true })
        .option("amount", { alias: "a", type: "number", demandOption: true })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructSolTransfer(
        argv.env as string,
        argv.cold as string,
        argv.recipient as string,
        argv.payer as string,
        argv.amount as number
      )
  )
  .command(
    "token-transfer",
    "Build an unsigned SPL token transfer from the Vector PDA",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("recipient", { alias: "r", type: "string", demandOption: true })
        .option("mint", { alias: "m", type: "string", demandOption: true })
        .option("amount", { alias: "a", type: "number", demandOption: true })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructTokenTransfer(
        argv.env as string,
        argv.cold as string,
        argv.recipient as string,
        argv.mint as string,
        argv.amount as number,
        argv.payer as string
      )
  )
  .command(
    "stake-create",
    "Build an unsigned: vault-funded stake account creation (auths = Vault PDA)",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("seed", { alias: "s", type: "string", demandOption: true, description: "Seed string for the stake account address (derived from vault)" })
        .option("amount", { alias: "a", type: "number", demandOption: true, description: "SOL to stake (incl. rent)" })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructStakeCreate(
        argv.env as string,
        argv.cold as string,
        argv.seed as string,
        argv.amount as number,
        argv.payer as string
      )
  )
  .command(
    "stake-delegate",
    "Build an unsigned delegate-to-validator instruction",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("stake", { alias: "s", type: "string", demandOption: true, description: "Stake account pubkey" })
        .option("validator", { alias: "v", type: "string", demandOption: true, description: "Validator vote-account pubkey" })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructStakeDelegate(
        argv.env as string,
        argv.cold as string,
        argv.stake as string,
        argv.validator as string,
        argv.payer as string
      )
  )
  .command(
    "stake-deactivate",
    "Build an unsigned deactivate-stake instruction",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("stake", { alias: "s", type: "string", demandOption: true, description: "Stake account pubkey" })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructStakeDeactivate(
        argv.env as string,
        argv.cold as string,
        argv.stake as string,
        argv.payer as string
      )
  )
  .command(
    "stake-withdraw",
    "Build an unsigned withdraw-from-stake instruction",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("stake", { alias: "s", type: "string", demandOption: true, description: "Stake account pubkey" })
        .option("amount", { alias: "a", type: "number", demandOption: true, description: "SOL to withdraw" })
        .option("recipient", { alias: "r", type: "string", demandOption: true })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructStakeWithdraw(
        argv.env as string,
        argv.cold as string,
        argv.stake as string,
        argv.amount as number,
        argv.recipient as string,
        argv.payer as string
      )
  )
  .command(
    "close-authority",
    "Build an unsigned close (rent goes to --close-to)",
    (y) =>
      y
        .option("cold", { alias: "c", type: "string", demandOption: true })
        .option("close-to", { alias: "t", type: "string", demandOption: true, description: "Rent destination pubkey" })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet PUBKEY (fee payer)" }),
    (argv) =>
      constructClose(
        argv.env as string,
        argv.cold as string,
        argv["close-to"] as string,
        argv.payer as string
      )
  )
  .command(
    "sign",
    "Sign the digest in unsigned-tx.json offline",
    (y) =>
      y
        .option("unsigned", { alias: "u", type: "string", default: "unsigned-tx.json" })
        .option("keypair", { alias: "k", type: "string", default: "cold-wallet.json" }),
    (argv) =>
      signOffline(argv.keypair as string, argv.unsigned as string)
  )
  .command(
    "broadcast",
    "Assemble [Ed25519 precompile, vector instruction] and broadcast",
    (y) =>
      y
        .option("unsigned", { alias: "u", type: "string", default: "unsigned-tx.json" })
        .option("signature", { alias: "s", type: "string", default: "signed-tx.json" })
        .option("payer", { alias: "p", type: "string", demandOption: true, description: "Hot-wallet keypair path" }),
    (argv) =>
      broadcast(
        argv.env as string,
        argv.unsigned as string,
        argv.signature as string,
        argv.payer as string
      )
  )
  .demandCommand(1, "You must provide a command.")
  .help()
  .parse();
