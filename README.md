# Offline Signer CLI

This toolkit provides a secure, standalone command-line executable for executing sensitive Solana transactions without exposing your private key to the internet.

It is designed to be run in a secure, air-gapped workflow.

## The Problem
1.  **Private Key Exposure:** Standard wallet workflows require your private key to be on an internet-connected device, increasing security risks for high-value operations.
2.  **Transaction Expiration:** Standard offline signing workflows are difficult on Solana due to the short lifespan (~1-2 minutes) of the `recentBlockhash`, making a manual air-gapped process unreliable.

## The Solution
1.  **Durable Nonces:** We eliminate the `recentBlockhash` problem by using a **Durable Nonce** account. This allows a transaction to be constructed online, signed securely offline, and broadcast hours or days later without expiring.
2.  **Air-Gapped Workflow:** The CLI is a single, standalone executable that can be run on any machine (online or offline) without an internet connection or any dependencies. Your private key *never* touches the internet.
3.  **Standalone Executable:** This tool is packaged as a single binary. There is no need to install Node.js, npm, or any other libraries.

---

## Security Features

* **True Cold Storage:** Your private key *never* leaves the offline machine.
* **Versioned Transactions:** Fully compatible with modern Solana standards (Address Lookup Tables, etc.).
* **Visual Verification:** The offline signer decodes and displays the transaction details (Amount, Recipient, Network) before asking for confirmation.
* **Hot/Cold Separation:** The `create-nonce` command separates the **Payer** (Hot Wallet) from the **Authority** (Cold Wallet), so you don't even need your private key to set up the account.
* **Human-Readable Inputs:** Handles decimal calculations automatically to prevent "Raw Unit" errors.

---

## Installation

### Option 1: Download Binary
Download the latest executable for your OS from the [Releases Page](https://github.com/ChainflowSOL/offline-signing-cli/releases) (Linux, macOS, Windows).
*No Node.js or dependencies required.*

### Option 2: Build from Source
```bash
# 1. Clone
gh repo clone ChainflowSOL/offline-signing-cli
cd offline-signer-toolkit

# 2. Install
pnpm install

# 3. Build (Generates binaries in dist/executables/)
pnpm build
```
> **Build Note:** You may see "Cannot resolve" warnings during the build process. These are false positives caused by `pkg` analyzing the minified bundle. If the build completes successfully, these can be safely ignored.
---

## Prerequisites & Dependencies

To run or build this tool from source, you will need the following installed on your system:

### System Requirements
* **Node.js (v18 or higher):** [Download Here](https://nodejs.org/)
* **pnpm:** The package manager used for this repo.
    ```bash
    npm install -g pnpm
    ```
* **Git:** To clone the repository.

### Libraries & Tech Stack

* **[tweetnacl](https://github.com/dchest/tweetnacl-js):** Implements the **Ed25519** signature scheme. This is the cryptographic engine used to securely sign transactions offline without exposing private keys.
* **[@solana/web3.js](https://github.com/solana-labs/solana-web3.js):** Standard library for Solana blockchain interaction.
* **[@solana/spl-token](https://github.com/solana-labs/solana-program-library):** Handles all SPL Token transfers.
* **[Commander.js](https://github.com/tj/commander.js):** Manages command-line arguments and sub-commands.
* **[Chalk (v4)](https://github.com/chalk/chalk):** Terminal styling.
    > ⚠️ **Dev Note:** We strictly use **Chalk v4.1.2** to ensure compatibility with the `pkg` binary compiler (v5+ is ESM-only).
* **[pkg](https://github.com/vercel/pkg):** Compiles the project into standalone executables.
* **[esbuild](https://github.com/evanw/esbuild):** Bundles TypeScript for fast compilation.

---
## The Workflow

This tool is designed to be run in a 3-step process that moves between your internet-connected (online) and air-gapped (offline) machines.


### One-Time Setup (Online)

Before you can use the tool, you need a Durable Nonce account.

* **Payer:** A hot wallet on your online machine.
* **Authority:** The Public Key of your Cold Wallet.

<details open>
<summary>Linux</summary>

  ```bash
  ./offline-signer-cli-linux create-nonce \
    --env devnet \
    --payer <path/to/hot-wallet.json> \
    --authority "<COLD_WALLET_PUBKEY>"
  ```
</details>

<details>
<summary>macOS</summary>

  ```bash
  ./offline-signer-cli-macos create-nonce \
    --env devnet \
    --payer <path/to/hot-wallet.json> \
    --authority "<COLD_WALLET_PUBKEY>"
  ```
</details>

* **Result:** A `nonceAddress.json` file is saved. Keep the address safe.

### Step 1: Construct (Online)

On your **online** machine, run the `sol-transfer` or `token-transfer` command to build your transaction. This creates the `unsigned-tx.json` file.

*For SOL Transfer:*

<details open>
  <summary>Linux</summary>
  
```bash
./offline-signer-cli-linux sol-transfer \
  --env devnet \
  --sender "<COLD_WALLET_PUBKEY>" \
  --recipient "<RECIPIENT_PUBKEY>" \
  --amount 0.1 \
  --nonce "<NONCE_ACCOUNT_PUBKEY>"
```
</details>

<details>
  <summary>macOS</summary>
  
```bash
./offline-signer-cli-macos sol-transfer \
  --env devnet \
  --sender "<COLD_WALLET_PUBKEY>" \
  --recipient "<RECIPIENT_PUBKEY>" \
  --amount 0.1 \
  --nonce "<NONCE_ACCOUNT_PUBKEY>"
```
</details>

*For Token Transfer:*
<details open>
<summary>Linux</summary>

```bash
./offline-signer-cli-linux token-transfer \
  --env devnet \
  --sender "<COLD_WALLET_PUBKEY>" \
  --recipient "<RECIPIENT_PUBKEY>" \
  --mint "<TOKEN_MINT_ADDRESS>" \
  --amount 0.1 \
  --nonce "<NONCE_ACCOUNT_PUBKEY>"
```
</details>

<details>
<summary>macOS</summary>

```bash
./offline-signer-cli-macos token-transfer \
  --env devnet \
  --sender "<COLD_WALLET_PUBKEY>" \
  --recipient "<RECIPIENT_PUBKEY>" \
  --mint "<TOKEN_MINT_ADDRESS>" \
  --amount 0.1 \
  --nonce "<NONCE_ACCOUNT_PUBKEY>"
```
</details>

* **Result:** `unsigned-tx.json` is created.
* **Note:** Copy `unsigned-tx.json` file to your air-gapped machine via USB.

### Step 2: Sign (Offline)
On your **air-gapped** machine, run the `sign` command. It will read your keypair and the unsigned transaction, and create a new file with the signature.

<details open>
<summary>Linux</summary>
  
```bash
./offline-signer-cli-linux sign \
  --keypair <path/to/cold-wallet.json> \
  --unsigned <path/to/unsigned-tx.json>
```
</details>

<details>
<summary>macOS</summary>
  
```bash
./offline-signer-cli-macos sign \
  --keypair <path/to/cold-wallet.json> \
  --unsigned <path/to/unsigned-tx.json>
```
</details>

* **Result:** `signed-tx.json` is created.
* **Note:** Copy `signed-tx.json` file back to your online machine.

### Step 3: Broadcast (Online)
On your **online** machine, run the `broadcast` command. It will read the original message and the new signature, combine them, and send the transaction.

<details open>
<summary>Linux</summary>
  
```bash
./offline-signer-cli-linux broadcast \
  --env devnet \
  --unsigned <path/to/unsigned-tx.json> \
  --signature <path/to/signed-tx.json>
```
  </details>
  
<details>
<summary>macOS</summary>
  
```bash
./offline-signer-cli-macos broadcast \
  --env devnet \
  --unsigned <path/to/unsigned-tx.json> \
  --signature <path/to/signed-tx.json>
```
  </details>
  
* **Result:** Prints the final Transaction Signature and Explorer link.
---

## Command Reference

### Global Flags
* `--env`: (Alias: `-e`) Target network (devnet or mainnet). (Default: *devnet*)

### `create-nonce`
Creates a new Durable Nonce account.
* `--payer <path>`: (Alias: `-p`) Path to the Hot Wallet keypair (pays the rent).
* `--authority <path>`: (Alias: `-a`) **Public Key** of the Cold Wallet (will control the nonce).

### `sol-transfer`
Constructs an unsigned SOL transfer.
* `--sender <pubkey>`: (Alias: `-s`) Sender public key (your cold wallet).
* `--recipient <pubkey>`: (Alias: `-r`) Recipient public key.
* `--amount <number>`: (Alias: `-a`) Amount of SOL to send.
* `--nonce <pubkey>`: (Alias: `-n`) Your nonce account public key.

### `token-transfer`
Constructs an unsigned SPL Token transfer.
* `--sender <pubkey>`: (Alias: `-s`) Sender public key (your cold wallet).
* `--recipient <pubkey>`: (Alias: `-r`) Recipient's main public key.
* `--mint <pubkey>`: (Alias: `-m`) The mint address of the token.
* `--amount <number>`: (Alias: `-a`) Amount of tokens (raw units).
* `--nonce <pubkey>`: (Alias: `-n`) Your nonce account public key.
* `--fee-payer <pubkey>`: (Alias: `-f`) **Optional.** The key to pay fees. (Default: *sender*)

### `sign`
Signs an unsigned transaction message on an offline machine.
* `--unsigned <path>`: (Alias: `-u`) Path to the `unsigned-tx.json` file. (Default: *./unsigned-tx.json*)
* `--keypair <path>`: (Alias: `-k`) Path to your cold wallet keypair(JSON). (Default: *./cold-wallet.json*)

### `broadcast`
Broadcasts a signed transaction to the network.
* `--unsigned <path>`: (Alias: `-u`) Path to the original `unsigned-tx.json` file. (Default: *./unsigned-tx.json*)
* `--signature <path>`: (Alias: `-s`) Path to the `signature.json` file. (Default: *./signed-tx.json*)

---

## Contributing

Contributions are welcome! If you are looking for ideas on where to start, we are currently looking for:

* **New Commands:** Staking (`stake`), Vote Accounts, and Governance proposals.

### How to Contribute
1.  **Fork** the repository.
2.  **Clone** your fork locally.
3.  **Create a branch** for your feature (`git checkout -b feature/new-command`).
4.  **Commit** your changes (`git commit -m 'feat: added staking support'`).
5.  **Push** to the branch (`git push origin feature/new-command`).
6.  Open a **Pull Request**.

---

## Contact & Support

If you encounter any issues or unexpected behavior, please check the [Issue Tracker](https://github.com/ChainflowSOL/offline-signing-cli/issues) to see if it has already been reported. If not, please open a new issue.

For direct inquiries or feedback, reach out to us on X: **[@ChainflowSOL](https://x.com/ChainflowSOL)**
