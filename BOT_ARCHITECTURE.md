# NFT Mint Bot v3.0 (CLI Edition) — Architecture & Guide

A command-line sniper tool for **Public** SeaDrop and **OpenSea Allowlist / FCFS** NFT drops across EVM chains (Ethereum, Base, Arbitrum, Optimism, Robinhood, etc.).

---

## ⚡ Key Architectural Upgrades (Stolen & Optimized)

### 1. Dual Mint Engines

#### 🌊 Engine A: Public Mint Engine (`src/engines/publicMintEngine.js`)
*Stolen from `morsyxbt/nft-public-mint`*
- **Zero OpenSea API or token dependencies**: Reads `mintPrice`, `feeRecipient`, `maxTotalMintableByWallet`, and `startTime` directly on-chain via SeaDrop contract calls (`getPublicDrop`).
- **Offline Pre-signing**: Encodes `mintPublic` calldata and cryptographically pre-signs all wallet transactions offline before the stage opens.
- **Instant Parallel Broadcast**: At $T=0$, writes raw signed transaction bytes directly to the RPC network in parallel using `Promise.allSettled()`.

#### ⚡ Engine B: OpenSea Allowlist & FCFS Engine (`src/engines/allowlistMintEngine.js`)
*Stolen from `zunmax/osnm-z` & Zun's Reverse Engineering Findings*
- **Reverse-Engineered SIWE Auth**: Uses internal OpenSea formatting (`encodeURI("https://opensea.io/")` trailing slash, lowercase addresses, parsed JSON verify payload) to obtain valid session cookies (~3.5-day TTL).
- **GraphQL Batch Querying with Field Aliasing**: Batches calldata generation for all wallets into a single GraphQL POST request (`query B { w0: swap(...), w1: swap(...) }`).
- **Connection Warming**: Pings `gql.opensea.io` and the RPC endpoint at $T-5\text{s}$ to keep HTTP/2 connections hot.
- **Tight Calldata Hammering**: At $T-1.5\text{s}$, enters a tight polling loop to capture server-generated signatures and salt the millisecond OpenSea opens the drop.
- **Zero-Latency Nonce Cache**: Pre-fetches nonces at $T-10\text{s}$ across all wallets.

#### 🐋 Engine C: Copy-Mint Engine & Whale Tracker (`src/engines/copyMintEngine.js`)
*Stolen & Adapted from `singledavinci/ultra-dads-copy-mint-bot`*
- **Mempool Pending Stream & Block Polling (`src/engines/trackerEngine.js`)**: Subscribes to pending transactions via WebSocket for sub-second mempool front-running, backed by HTTP block polling fallback.
- **EVM Function Classifier (`src/engines/mintClassifier.js`)**: Recognizes 20+ NFT mint signatures (SeaDrop, Manifold, Zora, thirdweb, generic mints) and immediately rejects non-mint transactions (swaps, approvals, marketplace orders).
- **Calldata Rewriter & Recipient Hijacker (`src/engines/calldataRewriter.js`)**: Automatically swaps out the whale's wallet address for your session burner addresses in SeaDrop, Manifold, Zora, and direct contract mints.
- **Payment & Safety Gate (`src/engines/paymentDetector.js`)**: Runs dry-run simulations to detect 0 ETH free vs paid mints, scales values for quantity overdrive, and enforces strict `MAX_MINT_ETH` ceiling caps.
- **In-Memory Deduplication Store (`src/engines/dedupeStore.js`)**: TTL cache preventing double-minting across mempool and confirmed blocks.
- **Remote Control & 24/7 Automint**: Full integration with the Telegram daemon (`/track`, `/untrack`, `/tracked`, `/copymint`) and interactive terminal wizard.

### 2. Multi-Channel Webhook Notifications (`src/utils/notifier.js`)
- **Discord Webhook**: Sends rich embeds with mint results, contract links, block numbers, transaction hashes, and latency in milliseconds.
- **Telegram Bot**: Sends instant Markdown notifications directly to your phone.
- **NFT Forward Alerts**: Sends token transfer confirmation when tokens are moved to your recipient wallet.

### 3. Post-Mint Auto-Forwarding (`src/engines/nftForwarder.js`)
- Inspects transaction receipt logs for ERC-721 `Transfer` and ERC-1155 `TransferSingle` events.
- Automatically calls `safeTransferFrom` to move minted tokens to a centralized `RECIPIENT_ADDRESS` (if specified).

### 4. Auto-Scheduling (`src/scheduler.js`)
- Polls `dropBySlug` every 30 seconds for schedule updates.
- If the drop creator postpones or moves the time, the bot automatically recalculates countdown timing.

---

## 🛠 Setup & Installation

### 1. Clone & Install
```bash
git clone <repo-url>
cd nft-mint-bot
npm install
```

### 2. Configure Environment (`.env`)
Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

Edit `.env` with your settings:
```env
# Alchemy API Key (Auto-expands for Ethereum, Base, Arbitrum, Optimism)
ALCHEMY_KEY=your_alchemy_key_here

# Default fallback RPC URL:
DEFAULT_RPC_URL=https://mainnet.base.org
DEFAULT_CHAIN=BASE

# Optional: Default forwarding recipient:
RECIPIENT_ADDRESS=0x...

# Optional: Discord Webhook URL for alerts:
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...

# Optional: Telegram Alerts:
TELEGRAM_BOT_TOKEN=123456789:ABC...
TELEGRAM_CHAT_ID=123456789
```

### 3. How to Get Alert Webhooks
- **Discord**: Go to your Discord server → Channel Settings → Integrations → Webhooks → Create Webhook → Copy Webhook URL.
- **Telegram**:
  1. Open Telegram and search for `@BotFather`.
  2. Send `/newbot` to create your bot and copy the API Token.
  3. Start a chat with `@userinfobot` or `@RawDataBot` to find your numeric **Chat ID**.
  4. Paste both into `.env`.

---

## 🚀 Running the Bot

Start the interactive wizard:
```bash
npm start
```
or
```bash
node cli.js
```

### Wizard Flow
1. **Mode**: Choose between `Allowlist / FCFS`, `Public Mint`, or `🐋 Copy-Mint Engine & Whale Tracker`.
2. **Copy-Mint Sub-Options**:
   - 🚀 **Live Tracker & Automint**: Continuous background mempool stream + block listener.
   - 📋 **Manage Tracked Whales**: Add, remove, and toggle tracked whale addresses.
   - 🔬 **Simulate Tx Hash**: Dry-run inspect past on-chain mint transactions.
   - 🏆 **Import Scout Whales**: 1-click import top profitable wallets from the Robinhood Alpha Scout.
3. **Chain & RPC**: Select Robinhood, Base, Ethereum, Arbitrum, Optimism, or Custom RPC.
4. **Private Keys**: Paste one or multiple private keys into the hidden prompt (supports multi-line paste).
5. **Recipient**: Press Enter to use `.env` default or paste custom recipient.
6. **Gas Settings**: Max fee (Gwei), priority tip (Gwei), or preset (`RAPID`, `INSTANT`, `ULTRA`).

