/**
 * Comprehensive Help & User Manual Command Handler
 */

/**
 * Main /help command
 */
async function handleHelp(ctx) {
  const { client, chatId, messageId } = ctx;

  const text = [
    `📖 <b>NFT MINT BOT — USER MANUAL & COMMAND GUIDE</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Welcome to the complete documentation for your 24/7 Robinhood Chain NFT minting daemon.`,
    `\n<b>Select a section below or explore all commands:</b>`,
    `\n🎯 <b>NFT SNIPER & DROP TRACKER</b>`,
    `• <code>/snipe</code> — Interactive wizard to arm a drop (Mode, Wallets, Quantity, Time)`,
    `• <code>/drops</code> — View, monitor, or cancel scheduled pending snipes`,
    `• <code>/trackmint &lt;link&gt;</code> — Track OpenSea drop phases (alerts at T-15m, T-5m, T-0)`,
    `• <code>/trackedmints</code> — List all actively monitored drops and countdowns`,
    `• <code>/untrackmint &lt;slug&gt;</code> — Stop tracking an OpenSea drop`,
    `\n⚡ <b>WHALE COPY-MINTING ENGINE</b>`,
    `• <code>/copymint</code> — Open the master copy-mint & whale tracker dashboard`,
    `• <code>/copymintwallets &lt;1, 2 | 1-5 | all&gt;</code> — Select which burner wallets participate`,
    `• <code>/copypnl [drop-name]</code> — View net profit, ROI, and individual drop analytics`,
    `• <code>/pnlcard</code> — Generate & send HD visual trading card image & SVG file`,
    `• <code>/resetpnl</code> — Wipe PnL history to a clean 0-state`,
    `• <code>/track &lt;0xAddress&gt; [Name]</code> — Add a whale wallet to copy`,
    `• <code>/tracked</code> — View, toggle, and manage tracked whale addresses`,
    `• <code>/untrack &lt;0xAddress&gt;</code> — Remove a whale wallet from tracking`,
    `• <code>/exportwhales</code> — 1-click export of TRACKED_WALLETS for Render cloud env`,
    `• <code>/maxprice &lt;ETH&gt;</code> — Set max ETH price ceiling per token (e.g. <code>/maxprice 0.05</code>)`,
    `• <code>/paidwallets &lt;1-5 | all&gt;</code> — Designate specific wallets for paid drops`,
    `• <code>/quantity &lt;num&gt;</code> — Set mint quantity per wallet (e.g. <code>/quantity 2</code>)`,
    `• <code>/gasmode &lt;mode&gt;</code> — Set speed (<code>RAPID</code>, <code>ULTRA</code>, <code>STANDARD</code>)`,
    `• <code>/setrecipient &lt;0xAddr&gt;</code> — Set cold storage address for auto-forwarding`,
    `\n⛽ <b>GAS, LATENCY & DIAGNOSTICS</b>`,
    `• <code>/gas</code> (or <code>/fees</code>) — Live Robinhood Base Fee & USD cost per mint`,
    `• <code>/ping</code> — Live round-trip ping to Sequencer, QuickNode, OpenSea & APIs`,
    `• <code>/latency</code> — Detailed multi-target VPS network benchmark from Ohio`,
    `• <code>/status</code> — Live daemon health, 24/7 uptime, and RAM usage`,
    `\n💼 <b>WALLET TOOLS & SWEEPING</b>`,
    `• <code>/wallets</code> — List all active session burner wallets`,
    `• <code>/balance</code> — Live ETH balances and transaction nonces across all wallets`,
    `• <code>/generate [count]</code> — Create new burner wallets on the fly`,
    `• <code>/fund [amount]</code> — Auto-distribute ETH from master wallet to burners`,
    `• <code>/sweep</code> — Drain remaining ETH and forward minted NFTs to cold storage`,
    `• <code>/export</code> — Download full mint history JSON log`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Tap a category below for in-depth workflow tutorials:</i>`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🎯 How Sniping Works', callback_data: 'help_cat_snipe' },
        { text: '⚡ How Copy-Mint Works', callback_data: 'help_cat_copymint' }
      ],
      [
        { text: '🎯 How Drop Tracking Works', callback_data: 'help_cat_tracker' },
        { text: '📦 How Sweeping Works', callback_data: 'help_cat_sweep' }
      ],
      [
        { text: '🏠 Open Main Dashboard', callback_data: 'menu_back' }
      ]
    ]
  };

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
  return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle category tutorial callbacks
 */
async function handleHelpCallback(client, chatId, messageId, data) {
  let text = '';
  if (data === 'help_cat_snipe') {
    text = [
      `🎯 <b>HOW THE NFT SNIPER WORKS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>1. Interactive Arming Wizard:</b>`,
      `Send <code>/snipe</code> to start. The bot asks for Target Contract, Mint Mode (Public / Allowlist), Wallet Selection, Quantity, and Start Time.`,
      `\n<b>2. Millisecond Clock Synchronization:</b>`,
      `For scheduled drops, the bot synchronizes to block time. At <b>T-0</b>, it blasts pre-signed transactions across your burner wallets simultaneously using redundant RPC connections.`,
      `\n<b>3. Real-time Telemetry:</b>`,
      `You receive an immediate alert when transactions are firing, followed by a full report showing which wallets succeeded, tx hashes, block numbers, and exact gas spent in USD.`,
      `\n<b>Useful Commands:</b>`,
      `• <code>/snipe</code> — Start wizard`,
      `• <code>/drops</code> — View active pending jobs`
    ].join('\n');
  } else if (data === 'help_cat_copymint') {
    text = [
      `⚡ <b>HOW WHALE COPY-MINTING WORKS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>1. Mempool Streaming:</b>`,
      `The bot monitors incoming transactions from your tracked whale list in real time.`,
      `\n<b>2. Automatic Calldata Rewriting:</b>`,
      `When a whale submits a mint transaction, the bot intercepts it, verifies it is a valid mint (anti-scam filter), rewrites the calldata to target YOUR burner wallets, and broadcasts it immediately.`,
      `\n<b>3. Safety Guards:</b>`,
      `• Max Price Cap (<code>/maxprice</code>) prevents you from copying overpriced trap mints.`,
      `• Paid Drop Wallets (<code>/paidwallets</code>) ensures paid mints only execute on funded wallets.`,
      `• Copy-Mint Wallets (<code>/copymintwallets</code>) lets you choose which wallets participate.`,
      `\n<b>Useful Commands:</b>`,
      `• <code>/copymint</code> — Main controls`,
      `• <code>/copypnl</code> — Profit summary`,
      `• <code>/pnlcard</code> — Generate visual trading card`,
      `• <code>/track 0x... Label</code> — Add a whale`
    ].join('\n');
  } else if (data === 'help_cat_tracker') {
    text = [
      `🎯 <b>HOW OPENSEA DROP TRACKING WORKS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>1. Track Any Drop:</b>`,
      `Send <code>/trackmint https://opensea.io/collection/echo-rh/drop</code> or <code>/trackmint &lt;slug&gt;</code>.`,
      `\n<b>2. Automated Stage Monitoring:</b>`,
      `The bot queries OpenSea GraphQL API every 30 seconds and checks when the drop transitions from private/allowlist to Public.`,
      `\n<b>3. Proactive Notifications:</b>`,
      `• <b>T-15m:</b> Pre-alert so you can prepare`,
      `• <b>T-5m:</b> High-priority warning that Public opens in 5 minutes`,
      `• <b>T-0 (LIVE):</b> Immediate alert with a 1-tap <b>[🎯 Snipe Now]</b> button!`,
      `\n<b>Useful Commands:</b>`,
      `• <code>/trackmint &lt;url&gt;</code> — Start tracking`,
      `• <code>/trackedmints</code> — List active drops`,
      `• <code>/untrackmint &lt;slug&gt;</code> — Remove drop`
    ].join('\n');
  } else if (data === 'help_cat_sweep') {
    text = [
      `📦 <b>HOW ASSET SWEEPING WORKS</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>1. Consolidate NFTs:</b>`,
      `Send <code>/sweep</code> to batch-transfer all minted NFTs from burner wallets into your cold storage address.`,
      `\n<b>2. Drain Remaining ETH:</b>`,
      `Sweeping can also drain any leftover ETH balances across burner wallets back to your primary wallet.`,
      `\n<b>3. Automatic Auto-Forwarding:</b>`,
      `Set <code>/setrecipient 0xYourAddress</code> so copy-minted NFTs are forwarded automatically upon mint completion!`
    ].join('\n');
  }

  const reply_markup = {
    inline_keyboard: [
      [{ text: '◀️ Back to Help Manual', callback_data: 'cmd_help_menu' }],
      [{ text: '🏠 Open Dashboard', callback_data: 'menu_back' }]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

module.exports = {
  handleHelp,
  handleHelpCallback
};
