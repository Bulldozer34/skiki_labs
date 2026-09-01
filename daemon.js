#!/usr/bin/env node

/**
 * NFT Mint Bot — 24/7 Telegram Daemon (v4.0)
 *
 * Runs continuously in the background, listening for commands and executing snipes
 * directly from your phone over Telegram.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const logger = require('./src/utils/logger');
const { CHAINS } = require('./src/utils/chains');
const WalletService = require('./src/services/walletService');
const TelegramBot = require('./src/bot/telegramBot');
const TrackerEngine = require('./src/engines/trackerEngine');
const CopyMintEngine = require('./src/engines/copyMintEngine');
const trackedWalletService = require('./src/services/trackedWalletService');
const connectionManager = require('./src/services/connectionManager');

async function startDaemon() {
  console.clear();
  logger.separator();
  console.log(`\x1b[36m   ███╗   ██╗███████╗████████╗    ██████╗  █████╗ ███████╗███╗   ███╗ ██████╗ ███╗   ██╗\x1b[0m`);
  console.log(`\x1b[36m   ████╗  ██║██╔════╝╚══██╔══╝    ██╔══██╗██╔══██╗██╔════╝████╗ ████║██╔═══██╗████╗  ██║\x1b[0m`);
  console.log(`\x1b[36m   ██╔██╗ ██║█████╗     ██║       ██║  ██║███████║█████╗  ██╔████╔██║██║   ██║██╔██╗ ██║\x1b[0m`);
  console.log(`\x1b[36m   ██║╚██╗██║██╔══╝     ██║       ██║  ██║██╔══██║██╔══╝  ██║╚██╔╝██║██║   ██║██║╚██╗██║\x1b[0m`);
  console.log(`\x1b[36m   ██║ ╚████║██║        ██║       ██████╔╝██║  ██║███████╗██║ ╚═╝ ██║╚██████╔╝██║ ╚████║\x1b[0m`);
  console.log(`\x1b[36m   ╚═╝  ╚═══╝╚═╝        ╚═╝       ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═══╝\x1b[0m`);
  console.log(`                                24/7 Mobile Control Engine\n`);
  logger.separator();

  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();

  if (!token) {
    logger.error('TELEGRAM_BOT_TOKEN is not set in your .env file.');
    logger.info('Please create a bot via @BotFather on Telegram and add TELEGRAM_BOT_TOKEN=... to .env');
    process.exit(1);
  }

  // 1. Initialize Default Blockchain Provider (Robinhood Mainnet) with persistent keep-alive & DNS cache
  const defaultChain = CHAINS.ROBINHOOD;
  const primaryRpc = defaultChain.defaultRpc || 'https://rpc.mainnet.chain.robinhood.com';
  const provider = connectionManager.createEthersProvider(primaryRpc, defaultChain.chainId);
  logger.info(`Connected Provider: ${defaultChain.name} (${defaultChain.chainId})`);

  // 2. Load Local Session Wallets
  let loadedWallets = [];
  try {
    // Look for latest wallets_*.txt or wallets.txt
    const files = fs.readdirSync(process.cwd());
    const walletFiles = files
      .filter(f => f.startsWith('wallets_') && f.endsWith('.txt'))
      .sort()
      .reverse();

    const targetFile = fs.existsSync('wallets.txt')
      ? 'wallets.txt'
      : (walletFiles.length > 0 ? walletFiles[0] : null);

    if (targetFile) {
      loadedWallets = WalletService.loadFromFile(targetFile);
      logger.success(`Loaded ${loadedWallets.length} session wallet(s) from ${targetFile}`);
    } else {
      logger.warn('No existing wallet file found on startup. You can generate them via Telegram with /generate');
    }
  } catch (err) {
    logger.warn(`Could not auto-load wallets on startup: ${err.message}`);
  }

  // 3. Initialize Whale Tracker Engine (Mempool WS + Blocks)
  const trackerEngine = new TrackerEngine({
    httpProvider: provider,
    wsRpcUrl: process.env.WS_RPC_URL || defaultChain.feedUrl,
    chainId: defaultChain.chainId,
    enablePending: process.env.ENABLE_PENDING_DETECTION !== 'false'
  });

  // 4. Shared Global Daemon State
  const daemonState = {
    startTimeMs: Date.now(),
    provider,
    defaultChain,
    wallets: loadedWallets,
    activeSnipes: new Map(),
    trackerEngine,
    automintEnabled: process.env.AUTOMINT_ENABLED !== 'false',
    maxMintEth: process.env.MAX_MINT_ETH || '0.05'
  };

  // 5. Connect Real-time Copy-Mint Listener
  trackerEngine.on('mint_detected', async (candidate) => {
    if (daemonState.automintEnabled === false) {
      logger.info(`[Daemon/CopyMint] Whale mint detected from ${candidate.label}, but Auto-Mint is PAUSED.`);
      return;
    }
    if (!daemonState.wallets || daemonState.wallets.length === 0) {
      logger.warn(`[Daemon/CopyMint] Whale mint detected from ${candidate.label}, but no burner wallets are loaded.`);
      return;
    }

    logger.info(`[Daemon/CopyMint] ⚡ Auto-executing copy-mint for ${daemonState.wallets.length} wallet(s)...`);
    try {
      await CopyMintEngine.execute({
        candidate,
        wallets: daemonState.wallets,
        provider: daemonState.provider,
        chainConfig: daemonState.defaultChain,
        options: {
          quantity: parseInt(process.env.DEFAULT_MINT_QUANTITY || '1', 10),
          maxMintEth: parseFloat(daemonState.maxMintEth || '0.05'),
          gasMode: process.env.DEFAULT_GAS_MODE || 'RAPID',
          autoForward: process.env.AUTO_FORWARD_COPY_MINTS !== 'false'
        }
      });
    } catch (err) {
      logger.error(`[Daemon/CopyMint] Auto-mint execution error: ${err.message}`);
    }
  });

  // Start background whale tracker
  await trackerEngine.start().catch(err => {
    logger.warn(`[Daemon] Whale tracker startup warning: ${err.message}`);
  });

  // 6. Initialize Telegram Bot
  const bot = new TelegramBot({
    token,
    allowedChatId: chatId,
    state: daemonState
  });

  // 7. Handle Graceful Shutdown
  const shutdown = () => {
    logger.info('Received shutdown signal. Stopping daemon...');
    trackerEngine.stop();
    bot.stop();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // 8. Launch Polling Loop
  await bot.start();
}

// ─── Global Safety Nets ─────────────────────────────────────────
// Prevent unhandled promise rejections (e.g. Telegram API timeouts
// inside fire-and-forget background tasks) from crashing the daemon.
process.on('unhandledRejection', (reason) => {
  logger.warn(`[Daemon] Unhandled rejection caught (daemon stays alive): ${reason?.message || reason}`);
});
process.on('uncaughtException', (err) => {
  logger.error(`[Daemon] Uncaught exception caught (daemon stays alive): ${err.message}`);
});

// Auto-retry on startup failure (e.g. Telegram connection reset)
(async function boot() {
  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await startDaemon();
      break; // if startDaemon returns cleanly (bot.stop()), exit loop
    } catch (err) {
      logger.error(`Daemon startup failed (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`);
      if (attempt === MAX_RETRIES) {
        logger.error('Max retries reached. Exiting.');
        process.exit(1);
      }
      const delay = Math.min(attempt * 3, 15);
      logger.info(`Retrying in ${delay}s...`);
      await new Promise(r => setTimeout(r, delay * 1000));
    }
  }
})();
