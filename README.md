# 🚀 OpenSea NFT Mint Sniper Bot (v3.0 CLI)

> **High-Speed, Multi-Wallet, Multi-RPC Command-Line NFT Sniper for OpenSea Allowlist/FCFS & Public SeaDrop Mints**

Whether you are a complete beginner with **zero coding experience** or an experienced Web3 trader, this guide will walk you through setting up and running the bot step-by-step in less than 5 minutes.

---

## 📑 Table of Contents

1. [✨ Key Features](#-key-features)
2. [🔗 Supported Blockchains](#-supported-blockchains)
3. [👶 Absolute Beginner Setup Guide (Zero Experience)](#-absolute-beginner-setup-guide-zero-experience)
   - [Step 1: Install Node.js & Git](#step-1-install-nodejs--git)
   - [Step 2: Download the Bot](#step-2-download-the-bot)
   - [Step 3: Open Terminal in the Bot Folder](#step-3-open-terminal-in-the-bot-folder)
   - [Step 4: Install Dependencies](#step-4-install-dependencies)
   - [Step 5: (Optional) Configure Your Settings](#step-5-optional-configure-your-settings)
   - [Step 6: Launch the Bot](#step-6-launch-the-bot)
4. [🔒 Wallet Safety & Getting Your Private Key](#-wallet-safety--getting-your-private-key)
   - [Safety First: Burner Wallets](#safety-first-burner-wallets)
   - [How to Export Private Keys Safely](#how-to-export-private-keys-safely)
5. [🎮 Step-by-Step Interactive CLI Walkthrough](#-step-by-step-interactive-cli-walkthrough)
6. [🎯 Special CLI Modes](#-special-cli-modes)
   - [🔍 1. Eligibility Pre-Check Mode (`--check`)](#1-eligibility-pre-check-mode---check)
   - [🔑 2. Bulk Wallet Generator Mode (`--generate`)](#2-bulk-wallet-generator-mode---generate)
   - [📁 3. Loading Multiple Wallets from a `.txt` File](#3-loading-multiple-wallets-from-a-txt-file)
7. [📱 Android Setup Guide (Termux)](#-android-setup-guide-termux)
8. [⚙️ Environment Configuration (`.env`) & Free RPCs](#-environment-configuration-env--free-rpcs)
9. [❌ Plain-English Troubleshooting Dictionary](#-plain-english-troubleshooting-dictionary)
10. [⚡ Speed Architecture & Security](#-speed-architecture--security)

---

## ✨ Key Features

| Feature | What It Does | Why It Matters |
|---|---|---|
| **⚡ Allowlist / FCFS Minting** | Authenticates with OpenSea (SIWE) and signs GraphQL mint requests | Win guaranteed or FCFS allowlist spots before the web UI even loads |
| **🌊 Public SeaDrop Minting** | Mints directly from the SeaDrop smart contract (no OpenSea login needed) | Snipes open public mints with zero web delays |
| **👥 Multi-Wallet Execution** | Paste multiple keys or load a `.txt` file to mint with many wallets at once | Maximize your allocation across all eligible wallets in a single run |
| **🏎️ Multi-RPC Broadcaster** | Sends your transactions across multiple RPC nodes simultaneously | The fastest node confirms your transaction first — zero stuck txs |
| **🛡️ Zero-Cost Simulation** | Tests your transaction before sending it to the blockchain | Catches errors before spending any gas fees |
| **📡 Auto-Scheduling** | Automatically watches the OpenSea drop page and fires the exact millisecond it goes live | No need to stare at the screen waiting for the countdown |
| **📬 NFT Forwarding** | Automatically sends minted NFTs to your cold storage or main wallet | Keep your valuable NFTs safe in cold storage immediately |
| **🔔 Discord & Telegram Alerts** | Sends notifications with transaction links when mints succeed or fail | Stay updated even if you are away from your computer |
| **🔍 Eligibility Checker** | Tests if your wallets are on the allowlist and checks quantity limits beforehand | Know in advance which wallets are eligible before the drop begins |
| **🔑 Built-in Wallet Generator** | Generates fresh Ethereum wallets and saves them to a file | Easily create burner wallets in 1 second |

---

## 🔗 Supported Blockchains

The bot supports all major EVM networks out of the box:

- **Ethereum Mainnet** (Chain ID: 1)
- **Base** (Chain ID: 8453)
- **Arbitrum One** (Chain ID: 42161)
- **Optimism** (Chain ID: 10)
- **Robinhood Chain** (Chain ID: 4663)
- **Robinhood Testnet** (Chain ID: 46630)
- **Sepolia Testnet** (Chain ID: 11155111)
- **Custom EVM Chain** (Any chain ID & RPC URL)

---

## 👶 Absolute Beginner Setup Guide (Zero Experience)

Follow these 6 simple steps to get the bot running on your computer.

### Step 1: Install Node.js & Git

The bot requires **Node.js** (version 18 or newer) to run.

#### On Windows:
1. Go to [https://nodejs.org/](https://nodejs.org/) and download the **LTS (Recommended for Most Users)** installer.
2. Run the installer and click **Next** through all steps (leave default options checked).
3. (Optional but recommended) Download and install **Git for Windows** from [https://git-scm.com/](https://git-scm.com/).

#### On macOS:
1. Download the **macOS Installer (.pkg)** from [https://nodejs.org/](https://nodejs.org/) and run it.
2. Or if you use Homebrew:
   ```bash
   brew install node git
   ```

#### On Linux (Ubuntu / Debian):
```bash
sudo apt update
sudo apt install -y nodejs npm git
```

---

### Step 2: Download the Bot

Choose **Option A** (Easiest for non-coders) or **Option B** (Git):

#### Option A: Download as ZIP (No Git needed)
1. Go to the GitHub repository: `https://github.com/Bulldozer34/opensea_nft_graphbot`
2. Click the green **`<> Code`** button near the top right.
3. Click **`Download ZIP`**.
4. Extract the downloaded ZIP file to your computer (e.g., your Downloads or Desktop folder).

#### Option B: Clone via Git
Open your terminal / command prompt and run:
```bash
git clone https://github.com/Bulldozer34/opensea_nft_graphbot.git
cd opensea_nft_graphbot
```

---

### Step 3: Open Terminal in the Bot Folder

You need to open a command prompt inside the folder containing the bot files:

#### Windows:
1. Open the folder where you extracted the bot in **File Explorer**.
2. Click on the address bar at the top of File Explorer.
3. Type `cmd` or `powershell` and press **Enter**.
4. A black terminal window will open, already in the correct folder!

#### macOS:
1. Open the folder in **Finder**.
2. Right-click the folder (or two-finger tap) → select **New Terminal at Folder**.

#### Linux:
1. Right-click anywhere in the folder → select **Open in Terminal**.

---

### Step 4: Install Dependencies

In the terminal window you opened in Step 3, type the following command and press **Enter**:

```bash
npm install
```

⏳ Wait 10–20 seconds for the packages to install. When finished, you should see a message like `added XX packages`.

---

### Step 5: (Optional) Configure Your Settings

The bot works out of the box with default settings, but creating a `.env` file allows you to add a free Alchemy key for higher speeds, or Discord/Telegram alert webhooks.

1. In your terminal, make a copy of `.env.example`:
   - **Windows (Command Prompt):**
     ```cmd
     copy .env.example .env
     ```
   - **Windows (PowerShell) / Mac / Linux:**
     ```bash
     cp .env.example .env
     ```
2. Open the new `.env` file with Notepad (Windows), TextEdit (Mac), or VS Code.
3. (Optional) Paste your free **Alchemy API Key** or **Discord Webhook** (see the [Environment Configuration section](#-environment-configuration-env--free-rpcs) below for details).
4. Save and close the file.

> 🔒 **Security Notice:** The `.env` file is automatically ignored by Git. It is stored only on your computer and is never shared online.

---

### Step 6: Launch the Bot!

Run this command in your terminal:

```bash
npm start
```

*(or `node cli.js`)*

🎉 The interactive menu will appear on your screen! Follow the on-screen prompts (detailed below in the [Interactive Walkthrough](#-step-by-step-interactive-cli-walkthrough)).

---

## 🔒 Wallet Safety & Getting Your Private Key

### Safety First: Burner Wallets
> ⚠️ **IMPORTANT RULE OF NFT TRADING:**
> - **NEVER** use your primary savings wallet or hardware vault (Ledger/Trezor) with any automated trading bot.
> - **ALWAYS** create a fresh, dedicated "burner" wallet for minting.
> - Fund the burner wallet only with the amount of ETH needed for the mint + gas.
> - Use the bot's **NFT Forwarding** feature to automatically send minted NFTs straight back to your safe cold storage wallet!

### How to Export Private Keys Safely

A private key is a 64-character hexadecimal code (with or without `0x` in front).

#### From MetaMask:
1. Open your MetaMask browser extension.
2. Make sure you are on your **burner wallet** account.
3. Click the **3 dots** (Account menu) in the top right → **Account Details**.
4. Click **Show Private Key**.
5. Enter your MetaMask password and click **Confirm**.
6. Copy the private key.

#### From Rabby Wallet:
1. Open Rabby → click the wallet icon in the top left.
2. Select your burner wallet → click the **Settings / Manage** icon.
3. Click **Export Private Key** → enter your password → copy the key.

---

## 🎮 Step-by-Step Interactive CLI Walkthrough

When you start the bot with `npm start`, it guides you step-by-step through 9 simple questions:

```
┌─────────────────────────────────────────────────────────────┐
│               NFT MINT SNIPER BOT v3.0 CLI                  │
└─────────────────────────────────────────────────────────────┘
```

### 1️⃣ Select Minting Mode
- **`⚡ OpenSea Allowlist / FCFS (Signed Mint via GraphQL)`**: Use this if the drop is an official OpenSea Allowlist or First-Come-First-Served mint requiring OpenSea signatures.
- **`🌊 Public Mint (Direct SeaDrop Contract)`**: Use this for standard public mints. Connects directly to the SeaDrop smart contract with zero OpenSea login overhead.

### 2️⃣ Select Chain & RPC
Choose the blockchain where the NFT collection is launching (e.g. `Ethereum`, `Base`, `Arbitrum`, `Optimism`, `Robinhood`, `Sepolia`, or `Custom`).
- The bot displays the default RPC endpoint. Press **Enter** to accept the default, or type a custom RPC URL.

### 3️⃣ Load Private Keys
Choose how to load your minting wallet(s):
- **`📋 Paste keys manually`**: Paste your private key(s) one by one. Press Enter on an empty line when finished. (Keys are masked with `*` for privacy).
- **`📁 Load from .txt file`**: Type the path to a text file containing one private key per line (e.g. `wallets.txt`).

> 🔒 **Privacy Guarantee:** Private keys exist **only in temporary computer memory** during the run. They are never saved to disk, logged, or transmitted anywhere outside of signing the transaction.

### 4️⃣ Recipient Forwarding Address (Optional)
- Type an Ethereum address (e.g., your Ledger / hardware wallet address) to automatically forward all minted NFTs as soon as they are minted.
- Or press **Enter** to leave blank, keeping the NFTs in the minting wallet(s).

### 5️⃣ Collection Identifier
Enter any of the following:
- **OpenSea URL**: `https://opensea.io/collection/example-drop`
- **Collection Slug**: `example-drop`
- **Contract Address**: `0x1234567890abcdef1234567890abcdef12345678`
- **Demo Mode**: Type `demo` or press Enter to run a zero-risk test on Sepolia / testnet.

### 6️⃣ NFT Quantity
Type how many NFTs each wallet should mint (e.g. `1`, `2`, `5`).

### 7️⃣ Gas Configuration
The bot automatically detects live network gas conditions and suggests optimal defaults:
- **Max Fee Per Gas (Gwei)**: The maximum fee you're willing to pay.
- **Priority Tip (Gwei)**: The bribe to the miner/validator for instant inclusion.
- **Gas Limit**: Default `300000` (or `200000` on L2s).
*Press Enter on each prompt to use the smart calculated defaults.*

### 8️⃣ Scheduling & Timing
- **`🚀 Mint Immediately`**: Fires transactions right away.
- **`📡 Auto-Schedule from OpenSea Drop Page`**: The bot monitors the OpenSea drop countdown and fires the instant the mint opens.
- **`⏰ Specific Start Time`**: Enter a specific Unix timestamp (e.g. `1740000000`) or ISO date string (e.g. `2026-08-30T18:00:00Z`).

### 9️⃣ Confirmation & Execution
Review the summary table. Press `Y` and Enter. The sniper bot arms itself, pre-fetches nonces, warms connections, simulates the transaction, and executes! 🚀

---

## 🎯 Special CLI Modes

In addition to standard minting, the bot comes with powerful built-in utility tools:

### 1. Eligibility Pre-Check Mode (`--check`)
Check if your wallets are on the allowlist, how many NFTs each wallet can mint, and the mint price **before the drop begins**:

```bash
# Windows / Mac / Linux
npm start -- --check
```
*(or `node cli.js --check`)*

**What it does:**
1. Lets you select the chain and load your wallets.
2. Checks OpenSea allowlist status for all wallets simultaneously.
3. Outputs a clean table displaying:
   - ✅ Eligible / ❌ Not Eligible status
   - Maximum allowed quantity per wallet
   - Mint price per token

---

### 2. Bulk Wallet Generator Mode (`--generate`)
Generate fresh Ethereum burner wallets in 1 second and automatically save them to a file:

```bash
# Generate 5 fresh burner wallets
npm start -- --generate 5
```
*(or `node cli.js --generate 10`)*

**What it does:**
1. Generates cryptographic Ethereum wallets with valid public addresses and private keys.
2. Displays a formatted table with addresses and keys.
3. Automatically saves the keys to a timestamped file (e.g., `wallets_20260827120000.txt`).
4. Prints an address-only list so you can easily copy and fund them with ETH.

---

### 3. Loading Multiple Wallets from a `.txt` File
Instead of typing private keys every time, you can create a simple text file:

1. Create a file named `wallets.txt` in the bot directory.
2. Paste one private key per line:
   ```text
   0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789
   ```
3. When running the bot, select **`📁 Load from .txt file`** and type `wallets.txt`.

> 🔒 *Note: `wallets.txt` and `wallets_*.txt` are automatically git-ignored so they will never be uploaded to GitHub.*

---

## 📱 Android Setup Guide (Termux)

You can run the sniper bot on any Android phone using the free **Termux** app!

### Step 1: Install Termux
Download and install **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/) (Recommended) or GitHub Releases.

### Step 2: Run Setup Commands in Termux
Open Termux and copy-paste these commands:

```bash
# 1. Update Termux packages
pkg update && pkg upgrade -y

# 2. Install Node.js and Git
pkg install -y nodejs-lts git

# 3. Clone the bot repository
git clone https://github.com/Bulldozer34/opensea_nft_graphbot.git

# 4. Enter the folder
cd opensea_nft_graphbot

# 5. Install dependencies
npm install

# 6. Start the bot!
node cli.js
```

### 💡 Android / Termux Tips:
- **Prevent Sleep / Background Killing:** Swipe down from your Android notification tray, tap the Termux notification, and tap **"Acquire wakelock"**.
- **Paste text in Termux:** Long-press anywhere on the black screen and tap **Paste**.
- **Stop the bot:** Press `Ctrl + C`.

---

## ⚙️ Environment Configuration (`.env`) & Free RPCs

All configuration in `.env` is optional, but setting up a free RPC provider significantly boosts your transaction speed.

### How to Get a 100% Free Alchemy Key (1 Minute):
1. Go to [https://alchemy.com](https://alchemy.com) and create a free account.
2. Click **Create new app** → choose **Ethereum** or **Base** → name it anything.
3. Click **API Key** and copy the key string (e.g. `alcht_...` or `AbCdEf123...`).
4. In your `.env` file, set:
   ```env
   ALCHEMY_KEY=your_alchemy_key_here
   ```
*The bot automatically uses this single key across Ethereum, Base, Arbitrum, and Optimism!*

### Complete `.env` Reference:

| Setting | Purpose | Default |
|---|---|---|
| `ALCHEMY_KEY` | Free Alchemy API key for ultra-fast RPC racing | *(Empty / uses public RPCs)* |
| `ANKR_KEY` | Free Ankr API key for backup Ethereum racing | *(Empty)* |
| `DEFAULT_RPC_URL` | Fallback RPC endpoint | `https://eth.llamarpc.com` |
| `DEFAULT_GAS_LIMIT` | Gas limit for mainnet transactions | `300000` |
| `DEFAULT_MAX_FEE_GWEI` | Max gas fee in Gwei | `25.0` |
| `DEFAULT_PRIORITY_FEE_GWEI` | Priority tip in Gwei | `1.5` |
| `RECIPIENT_ADDRESS` | Default safe wallet address to forward NFTs to | *(Empty / keeps in mint wallet)* |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for mint notifications | *(Empty)* |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from `@BotFather` | *(Empty)* |
| `TELEGRAM_CHAT_ID` | Telegram chat ID from `@userinfobot` | *(Empty)* |

---

## ❌ Plain-English Troubleshooting Dictionary

If something doesn't go as planned, look up the message below:

| What the Error Says | What Happened | How to Fix It |
|---|---|---|
| `"Your wallet doesn't have enough ETH to cover the mint price + gas fees"` | The wallet balance is too low. | Send more ETH to the burner wallet to cover the mint price plus a small buffer for gas. |
| `"The mint hasn't started yet"` | You fired before the official drop time. | Wait until the countdown finishes, or use **Auto-Schedule** mode. |
| `"You've already minted the maximum allowed per wallet"` | You reached the collection's wallet cap. | Use fresh burner wallets with the `--generate` command. |
| `"Your wallet is not on the allowlist for this mint"` | The wallet address is not registered for allowlist. | Use a wallet that won allowlist access, or run `--check` to verify first. |
| `"The smart contract rejected the transaction"` | The mint reverted (e.g. sold out or paused). | Verify on OpenSea if the collection is sold out or if requirements changed. |
| `"The ETH you sent isn't enough — the mint price may have changed"` | The price set in the contract was higher than expected. | Check the live drop price and retry. |
| `"Could not connect to the network"` | RPC node or internet issue. | Add a free `ALCHEMY_KEY` to your `.env` for more reliable connection. |
| `"Another transaction was already sent from this wallet"` | Nonce conflict (a transaction is already pending). | Wait for the previous transaction to finish or cancel it. |
| `"A previous transaction is still pending with higher gas"` | Replacement transaction underpriced. | Increase the Max Fee & Priority Tip in the gas settings. |
| `"File not found: wallets.txt"` | The `.txt` file path is incorrect. | Make sure `wallets.txt` is in the same folder where you ran `npm start`. |

---

## ⚡ Speed Architecture & Security

### Low-Latency Performance Engine
- **🔌 Multi-RPC Broadcast Racing:** Broadcasts signed raw transactions across multiple high-speed RPC endpoints at the same millisecond (`Promise.any`). The fastest node to reach the mempool wins.
- **🔢 In-Memory Sequential Nonce Queue:** Nonces are cached locally in memory, eliminating redundant network queries between consecutive transactions (-1 round-trip per tx).
- **⚡ GraphQL SIWE Pre-Warming:** Sockets are pre-warmed ahead of drop time, hammering the GraphQL endpoint with jittered backoff at T-1.5s for instant signature delivery.
- **🛡️ Pre-Flight Simulation:** Simulates execution locally before broadcasting, ensuring zero wasted gas on reverted transactions.

### Security Guarantees
- 🔒 **Zero Key Logging:** Private keys are stored in volatile RAM only for the duration of the process. They are NEVER written to disk, saved in logs, or exposed in output files.
- 🛡️ **Sanitized Output:** `mint-history.json` records only public wallet addresses and transaction hashes.
- 🚫 **Git Protection:** `.gitignore` blocks `.env`, `wallets.txt`, and `wallets_*.txt` from ever being uploaded.

---

## 📜 License

This project is open-source under the **MIT License**.

## ⚠️ Disclaimer

*This software is intended for educational, research, and personal use. Always test with small amounts and verify smart contract addresses before minting. The authors and contributors are not responsible for any financial loss or failed transactions.*

