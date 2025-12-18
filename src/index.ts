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
import { signOffline } from "./commands/sign"; 
import { broadcast } from "./commands/broadcast"; 
import { constructSolTransfer } from "./commands/sol_transfer"
import { constructTokenTransfer } from "./commands/token_transfer"
import { createNonce } from "./commands/create_nonce"

const argv = yargs(hideBin(process.argv))
  .scriptName("offline-signer")
  .option('env', {
      alias: 'e',
      type: 'string',
      description: 'Network environment (devnet/mainnet)',
      default: 'devnet',
      global: true,
  })
  // CREATE NONCE
  .command(
    'create-nonce',
    'Create a new durable nonce account',
    (yargs) => {
      return yargs
        .option('authority', { alias: 'a', type: 'string', demandOption: true, })
        .option('payer', { alias: 'p', type: 'string', default: 'hot-wallet.json', });
    },
    (argv) => {
      createNonce(argv.env, argv.payer, argv.authority);
    }
  )
  // SOL TRANSFER
  .command(
    'sol-transfer',
    'Construct an unsigned SOL transfer',
    (yargs) => {
      return yargs
        .option('sender', { alias: 's', type: 'string', demandOption: true })
        .option('recipient', { alias: 'r', type: 'string', demandOption: true })
        .option('amount', { alias: 'a', type: 'number', demandOption: true })
        .option('nonce', { alias: 'n', type: 'string', demandOption: true });
    },
    (argv) => {
      constructSolTransfer(argv.env, argv.sender, argv.recipient, argv.nonce, argv.amount);
    }
  )
  // TOKEN TRANSFER
  .command(
    'token-transfer',
    'Construct an unsigned SPL Token transfer',
    (yargs) => {
      return yargs
        .option('sender', { alias: 's', type: 'string', demandOption: true })
        .option('recipient', { alias: 'r', type: 'string', demandOption: true })
        .option('mint', { alias: 'm', type: 'string', demandOption: true })
        .option('amount', { alias: 'a', type: 'number', demandOption: true })
        .option('nonce', { alias: 'n', type: 'string', demandOption: true })
        .option('fee-payer', { alias: 'f', type: 'string' });
    },
    (argv) => {
      const feePayer = argv.feePayer || argv.sender;
      constructTokenTransfer(argv.env, argv.sender, argv.recipient, argv.mint, argv.amount, argv.nonce, feePayer);
    }
  )
  // SIGN
  .command(
    'sign',
    'Sign a transaction (Offline)',
    (yargs) => {
      return yargs
        .option('unsigned', { alias: 'u', type: 'string', default: 'unsigned-tx.json' })
        .option('keypair', { alias: 'k', type: 'string', default: 'cold-wallet.json' });
    },
    async (argv) => {
      await signOffline(argv.keypair, argv.unsigned);
    }
  )
  // BROADCAST
  .command(
    'broadcast',
    'Broadcast a signed transaction',
    (yargs) => {
      return yargs
        .option('unsigned', { alias: 'u', type: 'string', default: 'unsigned-tx.json' })
        .option('signature', { alias: 's', type: 'string', default: 'signed-tx.json' });
    },
    (argv) => {
      broadcast(argv.env, argv.unsigned, argv.signature);
    }
  )
  .demandCommand(1, 'You must provide a command.')
  .help()
  .parse();