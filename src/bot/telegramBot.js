const TelegramClient = require('../services/telegramClient');
const { handleStatus } = require('./commands/status');
const { handleStats, handleExport } = require('./commands/stats');
const { handleWallets } = require('./commands/wallets');
const { handleBalance } = require('./commands/balance');
const { handleGenerate } = require('./commands/generate');
const { handleFund } = require('./commands/fund');
const { handleDrops, handleDropCancel } = require('./commands/drops');
const { handleSnipe, handleSnipeCallback, handlePendingInput } = require('./commands/snipe');
const { handleSweep, handleSweepCallback, executeSweep, handleSweepPendingInput, activeSweepWizards } = require('./commands/sweep');
const { handleTrack, handleUntrack, handleTracked, handleTrackCallback } = require('./commands/track');
const {
  handleCopyMintMenu,
  handleCopyMintCallback,
  handleCopyMintPnL,
  handlePaidWalletsMenu,
  handleSetPaidWallets,
  handleSetMaxPrice,
  handleSetQuantity,
  handleSetGasMode,
  handleSetRecipient
} = require('./commands/copymint');
const trackedWalletService = require('../services/trackedWalletService');
const copyMintPnL = require('../services/copyMintPnL');
const logger = require('../utils/logger');

class TelegramBot {
  /**
   * @param {object} options
   * @param {string} options.token Telegram Bot Token
   * @param {string|number} options.allowedChatId Authorized Chat ID from .env
   * @param {object} options.state Shared daemon state (wallets, provider, etc.)
   */
  constructor({ token, allowedChatId, state }) {
    this.client = new TelegramClient(token);
    this.allowedChatId = allowedChatId ? String(allowedChatId).trim() : null;
    this.state = state || {};
    this.isRunning = false;
    this.offset = 0;
  }

  // ─── Main Menu: Three Category Toolkits ─────────────────────────
  async sendMainMenu(chatId, messageId = null) {
    const totalWallets = this.state.wallets ? this.state.wallets.length : 0;
    const activeDrops = this.state.activeSnipes ? this.state.activeSnipes.size : 0;
    const activeTracked = trackedWalletService.getActiveAddressesSet().size;
    const automintStatus = this.state.automintEnabled !== false ? '🟢 Active' : '🔴 Paused';

    const text = [
      `⚡ <b>NFT Mint Bot — Remote Control Dashboard</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🟢 <b>Daemon Status:</b> Active & Running 24/7`,
      `💼 <b>Active Wallets:</b> <code>${totalWallets}</code> loaded`,
      `🎯 <b>Active Background Snipes:</b> <code>${activeDrops}</code> scheduled`,
      `🐋 <b>Whale Copy-Mint:</b> ${automintStatus} (<code>${activeTracked}</code> tracked)`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>Tap a toolkit category below to explore commands:</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [{ text: '🎯 NFT SNIPER TOOLS', callback_data: 'menu_sniper' }],
        [{ text: '⚡ COPY-MINT & WHALE TRACKER', callback_data: 'menu_copymint' }],
        [{ text: '💼 WALLET MANAGEMENT', callback_data: 'menu_wallet' }]
      ]
    };

    if (messageId) {

      await this.client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    } else {
      await this.client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    }
  }

  // ─── NFT Sniper Sub-Menu ──────────────────────────────────────
  async sendSniperMenu(chatId, messageId) {
    const activeDrops = this.state.activeSnipes ? this.state.activeSnipes.size : 0;

    const text = [
      `<b>🎯 NFT SNIPER TOOLS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• <b>Arm Snipe:</b> Interactive tap wizard (Network ➔ Mode ➔ Wallets ➔ Qty ➔ Time)`,
      `• <b>Scheduled Drops:</b> View or cancel pending background drops (${activeDrops} active)`,
      `• <b>Stats & Speed Tracker:</b> On-chain mint telemetry & latency logs`,
      `• <b>Export History:</b> Download complete mint history JSON log`,
      `• <b>Daemon Status:</b> Uptime, RAM, and live Gwei feed`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>Select an action below:</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [{ text: '🎯 Arm New Snipe', callback_data: 'cmd_snipe' }],
        [{ text: '⏰ Scheduled Drops', callback_data: 'cmd_drops' }],
        [
          { text: '📊 Stats & Benchmarks', callback_data: 'cmd_stats' },
          { text: '📥 Export History', callback_data: 'cmd_export' }
        ],
        [
          { text: '🖥️ Daemon Health', callback_data: 'cmd_status' },
          { text: '◀️ Back to Dashboard', callback_data: 'menu_back' }
        ]
      ]
    };

    if (messageId) {
      await this.client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    } else {
      await this.client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    }
  }

  // ─── Wallet Management Sub-Menu ───────────────────────────────
  async sendWalletMenu(chatId, messageId) {
    const totalWallets = this.state.wallets ? this.state.wallets.length : 0;

    const text = [
      `<b>💼 WALLET MANAGEMENT TOOLS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• <b>Generate:</b> Create burner wallets & append to master <code>wallets.txt</code>`,
      `• <b>Auto-Fund:</b> Distribute ETH from Master Key to session burners`,
      `• <b>Live Balances:</b> Real-time ETH/USD balance, nonces & Gwei`,
      `• <b>Sweep Assets:</b> Transfer minted NFTs & drain ETH to your main wallet`,
      `• <b>Wallet List:</b> View all ${totalWallets} active session addresses`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>Select an action below:</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '✨ Generate 3', callback_data: 'cmd_gen:3' },
          { text: '✨ Generate 5', callback_data: 'cmd_gen:5' }
        ],
        [
          { text: '💸 Fund 0.005 ETH', callback_data: 'cmd_fund:0.005' },
          { text: '💸 Fund 0.01 ETH', callback_data: 'cmd_fund:0.01' }
        ],
        [
          { text: '💰 Live Balances', callback_data: 'cmd_balance' },
          { text: '📦 Sweep to Main', callback_data: 'cmd_sweep' }
        ],
        [
          { text: '💼 View Wallets', callback_data: 'cmd_wallets' },
          { text: '◀️ Back to Dashboard', callback_data: 'menu_back' }
        ]
      ]
    };

    if (messageId) {
      await this.client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    } else {
      await this.client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    }
  }

  /**
   * Process a single incoming update from Telegram
   */
  async processUpdate(update) {
    // 1. Handle incoming text messages
    if (update.message && update.message.text) {
      const msg = update.message;
      const chatId = String(msg.chat.id);

      // Strict security allowlist check
      if (this.allowedChatId && chatId !== this.allowedChatId) {
        logger.warn(`[TelegramBot] Unauthorized message attempt from Chat ID: ${chatId}. Discarding.`);
        return;
      }

      const text = msg.text.trim();
      const parts = text.split(/\s+/);
      const command = parts[0].toLowerCase();
      const args = parts.slice(1);

      const ctx = {
        client: this.client,
        chatId: msg.chat.id,
        args,
        messageText: text,
        state: this.state
      };

      // Check if wizard was waiting for plain text (e.g. contract address, schedule time, or sweep destination)
      if (handlePendingInput(ctx) || handleSweepPendingInput(ctx)) {
        return;
      }

      switch (command) {
        case '/start':
        case '/help':
        case '/menu':
          await this.sendMainMenu(msg.chat.id);
          break;
        case '/snipe':
          await handleSnipe(ctx);
          break;
        case '/drops':
        case '/scheduled':
          await handleDrops(ctx);
          break;
        case '/stats':
        case '/tracker':
        case '/history':
        case '/pnl':
          await handleStats(ctx);
          break;
        case '/copypnl':
        case '/copymintpnl':
        case '/pnlcard': {
          const wantsCard = (text || '').toLowerCase().includes('card') || command === '/pnlcard';
          await handleCopyMintPnL(this.client, msg.chat.id, null, wantsCard);
          break;
        }
        case '/resetpnl':
        case '/clearpnl': {
          copyMintPnL.reset();
          await this.client.sendMessage(msg.chat.id, '🗑️ <b>Copy-Mint PnL database wiped clean!</b> All mock records removed. Starting fresh with 0 drops.', { parse_mode: 'HTML' });
          break;
        }
        case '/export':
          await handleExport(ctx);
          break;
        case '/sweep':
        case '/consolidate':
          await handleSweep(ctx);
          break;
        case '/status':
          await handleStatus(ctx);
          break;
        case '/generate':
          await handleGenerate(ctx);
          break;
        case '/fund':
          await handleFund(ctx);
          break;
        case '/balance':
          await handleBalance(ctx);
          break;
        case '/wallets':
          await handleWallets(ctx);
          break;
        case '/copymint':
          await handleCopyMintMenu(this.client, msg.chat.id, null, this.state);
          break;
        case '/track':
          await handleTrack(this.client, msg.chat.id, text);
          break;
        case '/untrack':
          await handleUntrack(this.client, msg.chat.id, text);
          break;
        case '/tracked':
          await handleTracked(this.client, msg.chat.id);
          break;
        case '/maxprice':
          await handleSetMaxPrice(this.client, msg.chat.id, text, this.state);
          break;
        case '/quantity':
        case '/qty':
          await handleSetQuantity(this.client, msg.chat.id, text, this.state);
          break;
        case '/gasmode':
          await handleSetGasMode(this.client, msg.chat.id, text, this.state);
          break;
        case '/paidwallets':
          await handleSetPaidWallets(this.client, msg.chat.id, text, this.state);
          break;
        case '/setrecipient':
          await handleSetRecipient(this.client, msg.chat.id, text, this.state);
          break;
        default:
          if (command.startsWith('/')) {
            await this.client.sendMessage(msg.chat.id, `❓ Unknown command: <code>${command}</code>. Send /start to view menu.`, { parse_mode: 'HTML' });
          }
          break;
      }
    }

    // 2. Handle inline button callback queries
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = String(cb.message?.chat?.id);

      if (this.allowedChatId && chatId !== this.allowedChatId) {
        logger.warn(`[TelegramBot] Unauthorized callback query from Chat ID: ${chatId}. Discarding.`);
        return;
      }

      const data = cb.data || '';
      const ctx = {
        client: this.client,
        chatId: cb.message.chat.id,
        callbackQuery: cb,
        state: this.state
      };

      // ─── Menu Navigation ────────────────────────────────────
      if (data === 'menu_sniper') {
        await this.client.answerCallbackQuery(cb.id);
        return await this.sendSniperMenu(cb.message.chat.id, cb.message.message_id);
      }
      if (data === 'menu_copymint') {
        await this.client.answerCallbackQuery(cb.id);
        return await handleCopyMintMenu(this.client, cb.message.chat.id, cb.message.message_id, this.state);
      }
      if (data === 'menu_wallet') {
        await this.client.answerCallbackQuery(cb.id);
        return await this.sendWalletMenu(cb.message.chat.id, cb.message.message_id);
      }
      if (data === 'menu_back') {
        await this.client.answerCallbackQuery(cb.id);
        return await this.sendMainMenu(cb.message.chat.id, cb.message.message_id);
      }

      // ─── Copy-Mint & Whale Tracker Callbacks ─────────────────
      if (data.startsWith('cm_')) {
        await this.client.answerCallbackQuery(cb.id);
        return await handleCopyMintCallback(this.client, cb.message.chat.id, cb.message.message_id, data, this.state);
      }
      if (data.startsWith('tw_')) {
        await this.client.answerCallbackQuery(cb.id);
        return await handleTrackCallback(this.client, cb.message.chat.id, cb.message.message_id, data);
      }
      if (data === 'cmd_tracked') {
        await this.client.answerCallbackQuery(cb.id);
        return await handleTracked(this.client, cb.message.chat.id, cb.message.message_id);
      }

      // ─── Snipe Wizard Callbacks ─────────────────────────────
      if (data.startsWith('snipe_')) {
        const [action, param] = data.replace('snipe_', '').split(':');
        await handleSnipeCallback(ctx, action, param);
      }
      // ─── Sweep Callbacks ────────────────────────────────────
      else if (data.startsWith('sweep_sel:')) {
        const param = data.replace('sweep_sel:', '');
        await handleSweepCallback(ctx, param);
      } else if (data.startsWith('sweep_exec:')) {
        const recipient = data.replace('sweep_exec:', '');
        await this.client.answerCallbackQuery(cb.id);
        await executeSweep(ctx, recipient, cb.message.message_id);
      } else if (data === 'sweep_custom_dest') {
        const wizard = activeSweepWizards.get(String(chatId));
        if (wizard) {
          wizard.step = 'AWAIT_DESTINATION';
          await this.client.answerCallbackQuery(cb.id);
          await this.client.editMessageText(
            chatId,
            cb.message.message_id,
            `<b>✏️ Enter Destination Address</b>\n━━━━━━━━━━━━━━━━━━━━\nPlease reply with your target Ethereum address (<code>0x...</code>) to receive the swept assets:`,
            { parse_mode: 'HTML' }
          );
        }
      } else if (data === 'sweep_cancel') {
        activeSweepWizards.delete(String(chatId));
        await this.client.answerCallbackQuery(cb.id, { text: 'Sweep cancelled.' });
        await this.client.editMessageText(chatId, cb.message.message_id, '❌ <i>Sweep cancelled.</i>', { parse_mode: 'HTML' });
      }
      // ─── Drop Cancel ────────────────────────────────────────
      else if (data.startsWith('drop_cancel:')) {
        const dropId = data.replace('drop_cancel:', '');
        await handleDropCancel(ctx, dropId);
      }
      // ─── Fund ───────────────────────────────────────────────
      else if (data.startsWith('fund_batch:') || data.startsWith('cmd_fund:')) {
        const amount = data.split(':')[1];
        await this.client.answerCallbackQuery(cb.id);
        await handleFund({ ...ctx, args: [amount] });
      }
      // ─── Generate ───────────────────────────────────────────
      else if (data.startsWith('cmd_gen:')) {
        const count = data.split(':')[1] || '5';
        await this.client.answerCallbackQuery(cb.id);
        await handleGenerate({ ...ctx, args: [count] });
      }
      // ─── Direct Command Shortcuts ───────────────────────────
      else if (data === 'cmd_drops') {
        await this.client.answerCallbackQuery(cb.id);
        await handleDrops(ctx);
      } else if (data === 'cmd_stats') {
        await this.client.answerCallbackQuery(cb.id);
        await handleStats(ctx);
      } else if (data === 'cmd_export') {
        await this.client.answerCallbackQuery(cb.id);
        await handleExport(ctx);
      } else if (data === 'cmd_sweep') {
        await this.client.answerCallbackQuery(cb.id);
        await handleSweep(ctx);
      } else if (data === 'cmd_balance') {
        await this.client.answerCallbackQuery(cb.id);
        await handleBalance(ctx);
      } else if (data === 'cmd_wallets') {
        await this.client.answerCallbackQuery(cb.id);
        await handleWallets(ctx);
      } else if (data === 'cmd_status') {
        await this.client.answerCallbackQuery(cb.id);
        await handleStatus(ctx);
      } else if (data === 'cmd_snipe') {
        await this.client.answerCallbackQuery(cb.id);
        await handleSnipe(ctx);
      }
    }
  }

  /**
   * Start 24/7 long-polling loop
   */
  async start() {
    this.isRunning = true;
    const botUser = await this.client.getMe();
    logger.success(`🤖 Telegram Bot connected: @${botUser.username} (ID: ${botUser.id})`);

    // ─── Register slash command menu with Telegram ────────────
    const commandList = [
      { command: 'start', description: '🏠 Remote Control Dashboard' },
      { command: 'copymint', description: '⚡ Copy-Mint & Whale Tracker controls' },
      { command: 'copypnl', description: '📊 Copy-Mint PnL Card & Whale Rankings' },
      { command: 'track', description: '🐋 Track a new whale wallet' },
      { command: 'tracked', description: '📋 List & manage tracked whales' },
      { command: 'maxprice', description: '💰 Set max ETH price cap per token' },
      { command: 'paidwallets', description: '💼 Specify wallet numbers for paid drops (e.g. 1-5)' },
      { command: 'quantity', description: '🔢 Set mint quantity per wallet' },
      { command: 'gasmode', description: '⛽ Set gas speed preset' },
      { command: 'setrecipient', description: '📬 Set cold storage forwarding target' },
      { command: 'snipe', description: '🎯 Arm new NFT drop with wizard' },
      { command: 'sweep', description: '📦 Sweep NFTs & drain ETH to main' },
      { command: 'balance', description: '💰 Live wallet balances & nonces' },
      { command: 'stats', description: '📊 Mint & speed performance logs' },
      { command: 'export', description: '📥 Export mint history JSON' },
      { command: 'drops', description: '⏰ View & cancel scheduled drops' },
      { command: 'wallets', description: '💼 List active session wallets' },
      { command: 'generate', description: '✨ Generate burner wallets' },
      { command: 'fund', description: '💸 Auto-distribute ETH from master' },
      { command: 'status', description: '🖥️ Daemon health & live Gwei' },
      { command: 'help', description: '📖 Show command overview' }
    ];

    try {
      await this.client.setMyCommands(commandList);
      await this.client.setMyCommands(commandList, { type: 'all_private_chats' });
      await this.client.setChatMenuButton({ type: 'commands' });
      logger.success('✔ Slash commands & Chat Menu Button registered with Telegram');
    } catch (err) {
      logger.warn(`Could not register Telegram commands: ${err.message}`);
    }

    // ─── Flush stale updates from previous sessions ───────────
    try {
      const stale = await this.client.getUpdates(-1, 1);
      if (stale.length > 0) {
        this.offset = stale[stale.length - 1].update_id + 1;
        logger.info(`🧹 Flushed ${stale.length} stale update(s) from previous session.`);
      }
    } catch (e) {
      logger.warn(`[TelegramBot] Could not flush stale updates: ${e.message}`);
    }

    if (this.allowedChatId) {
      logger.info(`🔒 Security Allowlist Active: Chat ID ${this.allowedChatId}`);
      await this.client.sendMessage(
        this.allowedChatId,
        `🚀 <b>NFT Mint Bot Daemon is LIVE & Ready!</b>\nSend /start to open your dashboard.`,
        { parse_mode: 'HTML' }
      ).catch(() => {});
    } else {
      logger.warn('⚠️ TELEGRAM_CHAT_ID not set in .env! Send /start to the bot to find your Chat ID.');
    }

    // Long polling loop
    while (this.isRunning) {
      try {
        const updates = await this.client.getUpdates(this.offset, 25);
        for (const update of updates) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          await this.processUpdate(update).catch((err) => {
            logger.error(`[TelegramBot] Error processing update: ${err.message}`);
          });
        }
      } catch (err) {
        if (this.isRunning) {
          logger.warn(`[TelegramBot] Polling connection error: ${err.message}. Retrying in 3s...`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }
  }

  /**
   * Stop polling loop
   */
  stop() {
    this.isRunning = false;
    logger.info('Telegram Bot stopped.');
  }
}

module.exports = TelegramBot;
