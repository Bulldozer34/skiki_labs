# 🚀 OpenSea NFT Mint Sniper Bot (v3.0 CLI)

A high-speed command-line NFT minting bot that snipes **OpenSea Allowlist/FCFS** and **Public SeaDrop** mints across multiple EVM chains. Built for speed — features multi-wallet support, multi-RPC racing, pre-flight simulation, auto-scheduling, NFT forwarding, and Discord/Telegram alerts.

---

## ✨ Features

| Feature | Description |
|---|---|
| **Two Mint Modes** | OpenSea Allowlist/FCFS (signed via GraphQL) and Public Mint (direct SeaDrop contract — no OpenSea auth needed) |
| **Multi-Wallet** | Load multiple private keys and mint from all of them simultaneously |
| **Multi-RPC Racing** | Broadcast each transaction across multiple RPC nodes at once — the fastest node wins |
| **Pre-Flight Simulation** | Simulates your transaction before sending to catch errors early (costs zero gas) |
| **Auto-Scheduling** | Polls the OpenSea drop page and automatically fires when the mint goes live |
| **NFT Forwarding** | Automatically transfers minted NFTs to a recipient address (supports ERC-721 and ERC-1155) |
| **Discord & Telegram Alerts** | Get instant notifications on mint success/failure via webhooks |
| **Human-Readable Errors** | Failed mints show plain English explanations (e.g., "Not enough ETH" instead of raw hex) |

## 🔗 Supported Chains

| Chain | Chain ID |
|---|---|
| Ethereum Mainnet | 1 |
| Base | 8453 |
| Arbitrum One | 42161 |
| Optimism | 10 |
| Robinhood Chain | 4663 |
| Robinhood Testnet | 46630 |
| Sepolia Testnet | 11155111 |
| Custom EVM (any RPC) | Any |

---

## 💻 Desktop Setup (Windows / Mac / Linux)

### Prerequisites

- **Node.js v18+** — [Download here](https://nodejs.org/)
- **Git** — [Download here](https://git-scm.com/)
- A wallet private key with ETH for gas

### Step 1: Clone the Repository

```bash
git clone https://github.com/Bulldozer34/opensea_nft_graphbot.git
cd opensea_nft_graphbot
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment (Optional)

Copy the example environment file and fill in your keys:

```bash
# Windows
copy .env.example .env

# Mac / Linux
cp .env.example .env
```

Open `.env` in any text editor and configure:

```env
# Your Alchemy API key (free at https://alchemy.com) — optional but recommended
ALCHEMY_KEY=your_alchemy_key_here

# Default gas settings (you can also set these in the CLI)
DEFAULT_GAS_LIMIT=300000
DEFAULT_MAX_FEE_GWEI=25.0
DEFAULT_PRIORITY_FEE_GWEI=1.5

# Auto-forward all minted NFTs to this address (optional)
RECIPIENT_ADDRESS=

# Discord webhook URL for alerts (optional)
DISCORD_WEBHOOK_URL=

# Telegram bot alerts (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

> **Note:** The `.env` file is git-ignored and never uploaded. Your keys stay local.

### Step 4: Run the Bot

```bash
npm start
```

Or directly:

```bash
node cli.js
```

---

## 📱 Android Setup (Termux)

You can run this bot on your Android phone using **Termux** — a free terminal app.

### Step 1: Install Termux

Download **Termux** from [F-Droid](https://f-droid.org/en/packages/com.termux/) (recommended) or the Play Store.

> ⚠️ The Play Store version may be outdated. F-Droid is recommended.

### Step 2: Set Up Termux

Open Termux and run these commands one by one:

```bash
# Update packages
pkg update && pkg upgrade -y

# Install required tools
pkg install -y nodejs git

# Verify installation
node --version
npm --version
git --version
```

### Step 3: Clone and Install

```bash
# Clone the repo
git clone https://github.com/Bulldozer34/opensea_nft_graphbot.git

# Enter the project folder
cd opensea_nft_graphbot

# Install dependencies
npm install
```

### Step 4: Configure Environment (Optional)

```bash
# Copy example config
cp .env.example .env

# Edit with Termux's built-in editor
nano .env
```

Fill in your keys (see the Desktop section above for details), then save with `Ctrl+X → Y → Enter`.

### Step 5: Run the Bot

```bash
node cli.js
```

### Termux Tips

- **Keep Termux running in background:** Pull down the notification bar → tap the Termux notification → select "Acquire wakelock"
- **Paste text:** Long-press the screen → tap "Paste"
- **Stop the bot:** Press `Ctrl+C`
- **Run in background with screen:**
  ```bash
  pkg install screen
  screen -S mint
  node cli.js
  # Detach: Ctrl+A then D
  # Reattach: screen -r mint
  ```

---

## 🎮 How to Use (Step by Step)

When you run `node cli.js`, the bot walks you through an interactive menu:

### 1. Select Minting Mode
- **⚡ Allowlist / FCFS** — For invite-only or first-come-first-served mints on OpenSea. The bot authenticates with OpenSea and fetches signed calldata via GraphQL.
- **🌊 Public Mint** — For open public mints using the SeaDrop contract directly. No OpenSea login needed.

### 2. Select Chain
Pick the blockchain your NFT is on (Ethereum, Base, Arbitrum, etc.) or enter a custom RPC.

### 3. Enter Private Keys
Paste your wallet private key(s). You can paste multiple keys one by one. Press Enter on a blank line when done.

> 🔒 Keys are **never logged, saved to disk, or transmitted anywhere**. They exist only in memory during the session.

### 4. Recipient Address (Optional)
Enter an address to automatically forward minted NFTs to. Leave blank to keep them in the minting wallets.

### 5. Collection Identifier
Enter one of:
- An OpenSea collection URL (e.g., `https://opensea.io/collection/my-nft`)
- A collection slug (e.g., `my-nft`)
- A contract address (e.g., `0x1234...abcd`)

### 6. Quantity
How many NFTs to mint per wallet.

### 7. Gas Settings
Set your gas price and limits. The bot shows the current network gas price to help you decide.

### 8. Scheduling
- **🚀 Mint Immediately** — Fire right now
- **📡 Auto-Schedule** — The bot polls the OpenSea drop page and waits for the mint to go live
- **⏰ Custom Time** — Enter a specific Unix timestamp or ISO date

### 9. Confirm and Execute
Review the summary and confirm. The bot will:
1. Authenticate wallets (Allowlist mode)
2. Pre-fetch nonces and warm connections
3. Count down to the mint time
4. Broadcast transactions across all RPC nodes simultaneously
5. Show a results table with status, tx hash, and latency
6. Forward NFTs if a recipient is configured
7. Send Discord/Telegram alerts

---

## 🔧 Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `ALCHEMY_KEY` | No | Alchemy API key — auto-expands to the correct RPC URL per chain |
| `ANKR_KEY` | No | Ankr backup RPC key (used for Ethereum mainnet) |
| `DEFAULT_RPC_URL` | No | Fallback RPC if no Alchemy key is set |
| `DEFAULT_GAS_LIMIT` | No | Default gas limit (default: `300000`) |
| `DEFAULT_MAX_FEE_GWEI` | No | Default max fee in gwei (default: `25.0`) |
| `DEFAULT_PRIORITY_FEE_GWEI` | No | Default priority tip in gwei (default: `1.5`) |
| `RECIPIENT_ADDRESS` | No | Auto-forward minted NFTs to this address |
| `DISCORD_WEBHOOK_URL` | No | Discord webhook for mint alerts |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token (from @BotFather) |
| `TELEGRAM_CHAT_ID` | No | Telegram chat ID (from @userinfobot) |

---

## ❌ Common Error Messages Explained

If a mint fails, the bot shows a **plain-English explanation** alongside the technical error:

| What You See | What It Means | What to Do |
|---|---|---|
| "Your wallet doesn't have enough ETH to cover the mint price + gas fees" | Balance too low | Add more ETH to your wallet |
| "The mint hasn't started yet" | You're too early | Wait for the scheduled start time, or use Auto-Schedule mode |
| "You've already minted the maximum allowed per wallet" | Wallet cap reached | Use a different wallet |
| "Your wallet is not on the allowlist for this mint" | Not eligible | Make sure your wallet was added to the project's allowlist |
| "The smart contract rejected the transaction" | Generic revert | Mint may not be live, or parameters changed. Try again |
| "The ETH you sent isn't enough — the mint price may have changed" | Price mismatch | Check the current mint price and retry |
| "Could not connect to the network" | Network/RPC down | Check your internet or try a different RPC URL |
| "The RPC server is overloaded or down" | Server issue | Switch to a different RPC endpoint |
| "Another transaction was already sent from this wallet" | Nonce conflict | Wait for the pending tx to confirm, then retry |
| "A previous transaction is still pending with higher gas" | Replacement underpriced | Wait or increase gas settings |

---

## ⚡ Speed Moat & Performance Architecture

This bot is engineered to out-compete standard scripts and UI clickers through low-latency optimizations:

| Speed Engine | How It Works | Latency Advantage |
|---|---|---|
| **🔌 WebSocket RPC Racing** | Auto-expands RPCs to WebSocket (`wss://`) for instant push-based transaction confirmations | **-200ms to -500ms** vs HTTP polling |
| **🏎️ Multi-RPC Broadcaster** | Races multiple RPC endpoints simultaneously (`Promise.any`) — the fastest node broadcasts first | Prevents node throttling & stale endpoints |
| **🔢 In-Memory Nonce Queue** | Pre-fetches nonces and manages local sequential counter in memory | **-1 network round-trip** per transaction |
| **⛽ Dynamic Gas Estimator** | Queries `eth_feeHistory` in real time to calculate 75th percentile priority fees + base fee buffer | Guarantees next-block inclusion |
| **⚡ Parallel GraphQL Hammer** | Pre-warms sockets at T-5s and hammers GraphQL with jittered backoff at T-1.5s for instant signature delivery | Secures allowlist signatures 0.5-1.5s faster |
| **📊 Live Progress Tracker** | Real-time progress bar (`⚡ Minting Progress: [████████░░] 8/10`) with instant completion summary | Immediate visual feedback |
| **💾 Non-Blocking Async I/O** | History is recorded asynchronously in the background | Zero event loop freezes during minting |

---

## 🔒 Security Notes

- **Private keys are never logged or saved to disk.** They exist only in memory for the duration of the session.
- **Wallet objects are never included in result JSON** (SEC-01 fix) — `mint-history.json` only contains addresses, statuses, and tx hashes.
- **OpenSea sessions expire after 3.5 days** and are stored in memory only.
- **Discord webhook URLs are validated** — only official `discord.com/api/webhooks/` URLs are accepted.
- **GraphQL inputs are sanitized** — addresses are checksummed, chains are allow-listed, quantities are integers.

---

## 📂 Project Structure

```
opensea_nft_graphbot/
├── cli.js                          # Main CLI entry point
├── package.json
├── .env.example                    # Environment template
├── .gitignore
├── src/
│   ├── contracts/
│   │   └── seadrop.js              # SeaDrop ABI & helpers
│   ├── engines/
│   │   ├── allowlistMintEngine.js  # Allowlist/FCFS mint logic
│   │   ├── publicMintEngine.js     # Public SeaDrop mint logic
│   │   ├── multiRpcBroadcaster.js  # Multi-RPC racing broadcaster
│   │   ├── nftForwarder.js         # Auto-forward minted NFTs
│   │   └── preflightSimulator.js   # Pre-flight tx simulation
│   ├── services/
│   │   ├── authService.js          # OpenSea SIWE authentication
│   │   ├── collectionService.js    # Collection/drop info fetcher
│   │   ├── connectionManager.js    # Persistent HTTP/RPC & WebSocket pool
│   │   └── walletService.js        # Wallet key loading & nonce queue
│   ├── utils/
│   │   ├── asyncWriter.js          # Non-blocking file I/O writer
│   │   ├── chains.js               # Chain configurations
│   │   ├── errorTranslator.js      # Human-readable error messages
│   │   ├── gasEstimator.js         # Dynamic mempool gas estimation
│   │   ├── logger.js               # Colored CLI output & progress bar
│   │   ├── notifier.js             # Discord & Telegram alerts
│   │   └── resolver.js             # URL/slug/address resolver
│   └── scheduler.js                # Auto-schedule from OpenSea drops
```

---

## 📜 License

MIT

---

## ⚠️ Disclaimer

This tool is for **educational and personal use only**. Use at your own risk. The authors are not responsible for any financial losses, failed mints, or misuse of this software. Always verify contract addresses and mint details before executing transactions.
