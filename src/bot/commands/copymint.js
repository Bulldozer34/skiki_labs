/**
 * /copymint Command & Settings Handler — Real-time Copy-Mint & Whale Tracker Controls.
 *
 * Provides interactive tap buttons and slash commands to configure:
 * - Auto-minting state (ON/OFF)
 * - Maximum ETH price cap
 * - Mint quantity per wallet
 * - Gas mode preset (Rapid, Instant, Ultra, Standard)
 * - Safe mode filtering
 * - Auto-forwarding recipient
 */

const { ethers } = require('ethers');
const trackedWalletService = require('../../services/trackedWalletService');
const copyMintPnL = require('../../services/copyMintPnL');
const PnLCardGenerator = require('../../utils/pnlCardGenerator');
const { parseWalletNumbers, formatWalletNumbers } = require('../../utils/walletSelector');

/**
 * Render the main Copy-Mint Dashboard
 */
async function handleCopyMintMenu(client, chatId, messageId = null, state = {}) {
  const isAutomintEnabled = state.automintEnabled !== false;
  const trackedWallets = trackedWalletService.getWallets();
  const activeTrackedCount = trackedWalletService.getActiveAddressesSet().size;
  const maxMintEth = state.maxMintEth !== undefined ? state.maxMintEth : (process.env.MAX_MINT_ETH || '0.05');
  const quantity = state.quantity || parseInt(process.env.DEFAULT_MINT_QUANTITY || '1', 10);
  const gasMode = state.gasMode || process.env.DEFAULT_GAS_MODE || 'RAPID';
  const autoForward = state.autoForward !== false && (state.recipientAddress || process.env.RECIPIENT_ADDRESS);
  const safeMode = state.copyUnknownCalls !== true;
  const totalWallets = state.wallets ? state.wallets.length : 100;
  const copyWalletRule = state.copyMintWallets || process.env.COPYMINT_WALLETS || 'all';
  const copyIndices = parseWalletNumbers(copyWalletRule, totalWallets);
  const formattedCopy = formatWalletNumbers(copyIndices, totalWallets);
  const paidWalletRule = state.paidWalletNumbers || process.env.PAID_WALLET_NUMBERS || '1-5';
  const paidIndices = parseWalletNumbers(paidWalletRule, totalWallets);
  const formattedPaid = formatWalletNumbers(paidIndices, totalWallets);
  const trackerStats = state.trackerEngine ? state.trackerEngine.getStats() : { mintsDetected: 0, wsConnected: false };

  const text = [
    `⚡ <b>COPY-MINT & WHALE TRACKER</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🤖 <b>Auto-Mint Engine:</b> ${isAutomintEnabled ? '🟢 ENABLED (24/7 Snipe)' : '🔴 PAUSED (Alerts Only)'}`,
    `🐋 <b>Tracked Whales:</b> <code>${activeTrackedCount}</code> active (${trackedWallets.length} total)`,
    `💰 <b>Max Price Cap:</b> <code>${maxMintEth} ETH</code> per token`,
    `🔢 <b>Mint Quantity:</b> <code>${quantity}x</code> per burner wallet`,
    `💼 <b>Copy Wallets:</b> <code>${formattedCopy}</code>`,
    `💳 <b>Paid Drop Wallets:</b> <code>${formattedPaid}</code>`,
    `⛽ <b>Gas Speed:</b> <code>${gasMode}</code>`,
    `📬 <b>Auto-Forward:</b> ${autoForward ? `<code>${String(state.recipientAddress || process.env.RECIPIENT_ADDRESS).slice(0, 8)}...</code>` : '🔴 Disabled'}`,
    `🛡 <b>Safety Mode:</b> ${safeMode ? '🟢 Strict (Verified Mints Only)' : '🟡 Permissive'}`,
    `📡 <b>Mempool Stream:</b> ${trackerStats.wsConnected ? '🟢 WebSocket Active' : '🟡 Block Polling Mode'}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Tap a setting below to adjust on the fly:</i>`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        {
          text: isAutomintEnabled ? '⏸️ Pause Auto-Mint' : '▶️ Enable Auto-Mint',
          callback_data: 'cm_toggle_automint'
        }
      ],
      [
        { text: '📊 View Copy-Mint PnL Card', callback_data: 'cm_pnl' },
        { text: `💼 Copy Wallets (${formattedCopy.slice(0, 10)})`, callback_data: 'cm_menu_copywallets' }
      ],
      [
        { text: `💳 Paid Wallets (${formattedPaid.slice(0, 10)})`, callback_data: 'cm_menu_paid' },
        { text: `💰 Price Cap (${maxMintEth} ETH)`, callback_data: 'cm_menu_price' }
      ],
      [
        { text: `🔢 Quantity (${quantity}x)`, callback_data: 'cm_menu_qty' },
        { text: `⛽ Gas (${gasMode})`, callback_data: 'cm_menu_gas' }
      ],
      [
        { text: `🛡 Safe Mode (${safeMode ? 'ON' : 'OFF'})`, callback_data: 'cm_toggle_safemode' },
        { text: `📋 Tracked Whales (${activeTrackedCount})`, callback_data: 'cmd_tracked' }
      ],
      [
        { text: '➕ Add Whale', callback_data: 'cm_add_whale_prompt' },
        { text: '📈 Tracker Stats', callback_data: 'cm_stats' }
      ],
      [
        { text: '◀️ Back to Dashboard', callback_data: 'menu_back' }
      ]
    ]
  };

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
  return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

/**
 * Render Price Cap Selection Sub-Menu
 */
async function handlePriceMenu(client, chatId, messageId, state) {
  const current = state.maxMintEth !== undefined ? state.maxMintEth : (process.env.MAX_MINT_ETH || '0.05');

  const text = [
    `💰 <b>Set Maximum ETH Price Cap</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Current Cap: <code>${current} ETH</code>`,
    `\n<i>Mints that cost more than this ceiling will be automatically blocked to prevent draining. Free (0 ETH) mints are always allowed.</i>`,
    `\nSelect a preset below or send <code>/maxprice &lt;amount&gt;</code> (e.g. <code>/maxprice 0.03</code>):`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '0.005 ETH (~$12)', callback_data: 'cm_set_price:0.005' },
        { text: '0.01 ETH (~$25)', callback_data: 'cm_set_price:0.01' }
      ],
      [
        { text: '0.025 ETH (~$60)', callback_data: 'cm_set_price:0.025' },
        { text: '0.05 ETH (~$125)', callback_data: 'cm_set_price:0.05' }
      ],
      [
        { text: '0.10 ETH (~$250)', callback_data: 'cm_set_price:0.1' },
        { text: '0.25 ETH (~$625)', callback_data: 'cm_set_price:0.25' }
      ],
      [
        { text: '🆓 Free Only (0 ETH)', callback_data: 'cm_set_price:0' }
      ],
      [
        { text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }
      ]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

/**
 * Render Quantity Selection Sub-Menu
 */
async function handleQuantityMenu(client, chatId, messageId, state) {
  const current = state.quantity || parseInt(process.env.DEFAULT_MINT_QUANTITY || '1', 10);

  const text = [
    `🔢 <b>Set Mint Quantity per Wallet</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Current Quantity: <code>${current}x</code>`,
    `\n<i>The bot will automatically rewrite the quantity in the transaction calldata for all burner wallets.</i>`,
    `\nSelect a preset below or send <code>/quantity &lt;number&gt;</code> (e.g. <code>/quantity 3</code>):`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '1 NFT', callback_data: 'cm_set_qty:1' },
        { text: '2 NFTs', callback_data: 'cm_set_qty:2' },
        { text: '3 NFTs', callback_data: 'cm_set_qty:3' }
      ],
      [
        { text: '5 NFTs', callback_data: 'cm_set_qty:5' },
        { text: '10 NFTs', callback_data: 'cm_set_qty:10' }
      ],
      [
        { text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }
      ]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

/**
 * Render Gas Preset Sub-Menu
 */
async function handleGasMenu(client, chatId, messageId, state) {
  const current = state.gasMode || process.env.DEFAULT_GAS_MODE || 'RAPID';

  const text = [
    `⛽ <b>Select Gas Mode for Copy-Minting</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Current Speed: <code>${current}</code>`,
    `\n• <b>⚡ RAPID:</b> Optimal for fast inclusion without overpaying (+15% tip).`,
    `• <b>🚀 INSTANT:</b> Next-block priority guarantee (+35% tip).`,
    `• <b>🔥 ULTRA:</b> Aggressive mempool front-running (+75% tip).`,
    `• <b>⏱ STANDARD:</b> Baseline base fee (economical).`,
    `\nSelect a speed below or send <code>/gasmode &lt;mode&gt;</code>:`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '⚡ RAPID', callback_data: 'cm_set_gas:RAPID' },
        { text: '🚀 INSTANT', callback_data: 'cm_set_gas:INSTANT' }
      ],
      [
        { text: '🔥 ULTRA', callback_data: 'cm_set_gas:ULTRA' },
        { text: '⏱ STANDARD', callback_data: 'cm_set_gas:STANDARD' }
      ],
      [
        { text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }
      ]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

/**
 * Handle Copy-Mint Callback Queries
 */
async function handleCopyMintCallback(client, chatId, messageId, data, state = {}, cbId = null) {
  // Toggle auto-mint
  if (data === 'cm_toggle_automint') {
    state.automintEnabled = !(state.automintEnabled !== false);
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Toggle safe mode
  if (data === 'cm_toggle_safemode') {
    state.copyUnknownCalls = !Boolean(state.copyUnknownCalls);
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Sub-menus
  if (data === 'cm_menu_price') {
    return await handlePriceMenu(client, chatId, messageId, state);
  }
  if (data === 'cm_menu_qty') {
    return await handleQuantityMenu(client, chatId, messageId, state);
  }
  if (data === 'cm_menu_gas') {
    return await handleGasMenu(client, chatId, messageId, state);
  }
  if (data === 'cm_menu_paid') {
    return await handlePaidWalletsMenu(client, chatId, messageId, state);
  }

  // Set Price
  if (data.startsWith('cm_set_price:')) {
    const val = data.split(':')[1];
    state.maxMintEth = val;
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Set Quantity
  if (data.startsWith('cm_set_qty:')) {
    const val = parseInt(data.split(':')[1], 10);
    state.quantity = val;
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Set Paid Wallets
  if (data.startsWith('cm_set_paid:')) {
    const val = data.split(':')[1];
    state.paidWalletNumbers = val;
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Set Gas
  if (data.startsWith('cm_set_gas:')) {
    const mode = data.split(':')[1];
    state.gasMode = mode;
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // Add Whale prompt
  if (data === 'cm_add_whale_prompt') {
    const promptText = [
      `➕ <b>Add a Whale Wallet to Track</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Send a message with:`,
      `<code>/track &lt;0xAddress&gt; [Label]</code>`,
      `\nExample:`,
      `<code>/track 0x460d7DFa923C363d6b8F421D599Aee1648a73bEE OEGP Alpha</code>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [{ text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }]
      ]
    };

    return await client.editMessageText(chatId, messageId, promptText, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }

  // Copy-Mint Wallets Sub-Menu
  if (data === 'cm_menu_copywallets') {
    return await handleCopyMintWalletsMenu(client, chatId, messageId, state);
  }

  // Set Copy-Mint Wallets preset
  if (data.startsWith('cm_set_copywallets:')) {
    const rule = data.split(':')[1];
    state.copyMintWallets = rule;
    if (cbId) await client.answerCallbackQuery(cbId, { text: `Copy-Mint Wallets set to: ${rule}` }).catch(() => {});
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

  // PnL Card view (all drops or filtered)
  if (data === 'cm_pnl') {
    return await handleCopyMintPnL(client, chatId, messageId, false, null);
  }

  // Filtered PnL for specific individual collection
  if (data.startsWith('cm_pnl_coll_')) {
    const filter = data.replace('cm_pnl_coll_', '');
    return await handleCopyMintPnL(client, chatId, messageId, false, filter);
  }

  // Generate & Download HD Card (with inline Photo and SVG file)
  if (data === 'cm_pnl_card' || data.startsWith('cm_pnl_card_')) {
    const filter = data.startsWith('cm_pnl_card_') ? data.replace('cm_pnl_card_', '') : null;
    if (cbId) await client.answerCallbackQuery(cbId, { text: 'Rendering HD PnL Card & Image...' }).catch(() => {});
    return await handleCopyMintPnL(client, chatId, null, true, filter);
  }

  // Reset PnL
  if (data === 'cm_pnl_reset_confirm') {
    copyMintPnL.reset();
    if (cbId) await client.answerCallbackQuery(cbId, { text: '🗑️ PnL records wiped clean!' }).catch(() => {});
    return await handleCopyMintPnL(client, chatId, messageId);
  }

  // Stats view
  if (data === 'cm_stats') {
    const trackerStats = state.trackerEngine ? state.trackerEngine.getStats() : {};
    const text = [
      `📊 <b>Whale Tracker Live Metrics</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `• <b>Mempool Transactions Seen:</b> <code>${trackerStats.pendingSeen || 0}</code>`,
      `• <b>Blocks Scanned:</b> <code>${trackerStats.blocksSeen || 0}</code>`,
      `• <b>Mints Detected:</b> <code>${trackerStats.mintsDetected || 0}</code>`,
      `• <b>Duplicates Filtered:</b> <code>${trackerStats.duplicatesSkipped || 0}</code>`,
      `• <b>Non-Mints Rejected:</b> <code>${trackerStats.nonMintsRejected || 0}</code>`,
      `• <b>WebSocket Reconnects:</b> <code>${trackerStats.wsReconnects || 0}</code>`,
      `━━━━━━━━━━━━━━━━━━━━`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [{ text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }]
      ]
    };

    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
}

/**
 * Render Copy-Mint PnL & Performance Report (with inline PNG Photo & SVG Vector Card)
 */
async function handleCopyMintPnL(client, chatId, messageId = null, sendCardFile = false, targetContractOrSlug = null) {
  const summary = await copyMintPnL.getSummary(targetContractOrSlug);
  PnLCardGenerator.saveSvgCardToFile(summary);
  const text = PnLCardGenerator.formatTelegramMessage(summary);

  const keyboard = [
    [
      { text: '🖼️ Send Card Image & File', callback_data: `cm_pnl_card${targetContractOrSlug ? `_${targetContractOrSlug}` : ''}` },
      { text: '🔄 Refresh', callback_data: `cm_pnl${targetContractOrSlug ? `_${targetContractOrSlug}` : ''}` }
    ]
  ];

  // If viewing all drops and multiple individual collections exist, add tap buttons per drop!
  if (!targetContractOrSlug && summary.topCollections && summary.topCollections.length > 0) {
    const collButtons = summary.topCollections.slice(0, 4).map(c => ({
      text: `🔎 ${c.collectionName.slice(0, 16)} (+$${(c.netProfitUsd || 0).toFixed(0)})`,
      callback_data: `cm_pnl_coll_${c.contractAddress.slice(0, 10)}`
    }));
    for (let i = 0; i < collButtons.length; i += 2) {
      keyboard.push(collButtons.slice(i, i + 2));
    }
  }

  keyboard.push([
    { text: '🗑️ Reset PnL to 0', callback_data: 'cm_pnl_reset_confirm' },
    { text: targetContractOrSlug ? '📊 All Drops PnL' : '◀️ Back to Menu', callback_data: targetContractOrSlug ? 'cm_pnl' : 'menu_copymint' }
  ]);

  const reply_markup = { inline_keyboard: keyboard };

  if (sendCardFile) {
    const svgCode = PnLCardGenerator.generateSvgCard(summary);
    const photoUrl = PnLCardGenerator.generateQuickChartCardUrl(summary);
    const filename = `${(summary.topCollections[0]?.collectionSlug || 'copymint')}_card.svg`;
    try {
      // 1. Send the visual image card
      await client.sendPhoto(chatId, photoUrl, text, { reply_markup });
      // 2. Also send the HD vector SVG document file
      await client.sendDocument(chatId, Buffer.from(svgCode, 'utf-8'), filename);
      return;
    } catch (err) {
      logger.warn(`[CopyMint] sendPhoto failed, fallback to sendDocument: ${err.message}`);
      try {
        return await client.sendDocument(chatId, Buffer.from(svgCode, 'utf-8'), filename, text, { reply_markup });
      } catch (err2) {}
    }
  }

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
  return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle /maxprice <amount>
 */
async function handleSetMaxPrice(client, chatId, text, state) {
  const parts = (text || '').trim().split(/\s+/);
  const amount = parts[1];

  if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) < 0) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/maxprice &lt;ETH amount&gt;</code> (e.g. <code>/maxprice 0.05</code>)`,
      { parse_mode: 'HTML' }
    );
  }

  state.maxMintEth = amount.trim();
  await client.sendMessage(
    chatId,
    `✅ <b>Maximum ETH Price Cap updated to:</b> <code>${amount.trim()} ETH</code> per token.`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle /quantity <number>
 */
async function handleSetQuantity(client, chatId, text, state) {
  const parts = (text || '').trim().split(/\s+/);
  const qty = parseInt(parts[1], 10);

  if (!qty || isNaN(qty) || qty < 1) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/quantity &lt;number&gt;</code> (e.g. <code>/quantity 2</code>)`,
      { parse_mode: 'HTML' }
    );
  }

  state.quantity = qty;
  await client.sendMessage(
    chatId,
    `✅ <b>Mint Quantity updated to:</b> <code>${qty}x</code> per wallet.`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle /gasmode <mode>
 */
async function handleSetGasMode(client, chatId, text, state) {
  const parts = (text || '').trim().split(/\s+/);
  const mode = (parts[1] || '').toUpperCase();
  const validModes = ['RAPID', 'INSTANT', 'ULTRA', 'STANDARD', 'AGGRESSIVE'];

  if (!validModes.includes(mode)) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/gasmode &lt;RAPID|INSTANT|ULTRA|STANDARD&gt;</code>`,
      { parse_mode: 'HTML' }
    );
  }

  state.gasMode = mode;
  await client.sendMessage(
    chatId,
    `✅ <b>Gas Mode updated to:</b> <code>${mode}</code>.`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle /setrecipient <0xAddress>
 */
async function handleSetRecipient(client, chatId, text, state) {
  const parts = (text || '').trim().split(/\s+/);
  const address = parts[1];

  if (!address || !ethers.isAddress(address)) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/setrecipient &lt;0xColdStorageAddress&gt;</code>`,
      { parse_mode: 'HTML' }
    );
  }

  state.recipientAddress = address.trim();
  state.autoForward = true;
  await client.sendMessage(
    chatId,
    `✅ <b>NFT Forwarding Recipient updated to:</b> <code>${ethers.getAddress(address.trim())}</code>. Minted tokens will be automatically swept here.`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Render Paid Wallets Selection Sub-Menu
 */
async function handlePaidWalletsMenu(client, chatId, messageId, state) {
  const totalWallets = state.wallets ? state.wallets.length : 100;
  const currentRule = state.paidWalletNumbers || process.env.PAID_WALLET_NUMBERS || '1-5';
  const indices = parseWalletNumbers(currentRule, totalWallets);
  const formatted = formatWalletNumbers(indices, totalWallets);

  const text = [
    `💼 <b>Configure Wallets for Paid Copy-Mints</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Current Selection: <code>${formatted}</code>`,
    `\n<i><b>Free Mints ($0 ETH):</b> Always execute across ALL loaded burner wallets.</i>`,
    `<i><b>Paid Mints (> $0 ETH):</b> ONLY execute on the designated wallet numbers below to protect zero-balance wallets.</i>`,
    `\nSelect a preset below or send <code>/paidwallets &lt;numbers&gt;</code> (e.g. <code>/paidwallets 1, 3, 7</code> or <code>/paidwallets 1-5</code>):`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: 'Wallets #1, #2, #3', callback_data: 'cm_set_paid:1,2,3' },
        { text: 'Wallets #1–#5', callback_data: 'cm_set_paid:1-5' }
      ],
      [
        { text: 'Wallets #1–#10', callback_data: 'cm_set_paid:1-10' },
        { text: 'Wallets #1–#20', callback_data: 'cm_set_paid:1-20' }
      ],
      [
        { text: '🌐 All Wallets (100%)', callback_data: 'cm_set_paid:all' },
        { text: '🆓 None (Free Mints Only)', callback_data: 'cm_set_paid:none' }
      ],
      [
        { text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }
      ]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

/**
 * Handle /paidwallets <numbers> (e.g. /paidwallets 1, 3, 7 or /paidwallets 1-5 or /paidwallets all)
 */
async function handleSetPaidWallets(client, chatId, text, state) {
  const totalWallets = state.wallets ? state.wallets.length : 100;
  const parts = (text || '').trim().split(/\s+/);
  const rawRule = parts.slice(1).join(' ');

  if (!rawRule) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/paidwallets &lt;1-5 | 1, 3, 7 | all | none&gt;</code>\nExample: <code>/paidwallets 1, 3, 7</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const indices = parseWalletNumbers(rawRule, totalWallets);
  const formatted = formatWalletNumbers(indices, totalWallets);

  state.paidWalletNumbers = rawRule;
  await client.sendMessage(
    chatId,
    `✅ <b>Paid Mint Wallets updated to:</b> <code>${formatted}</code>.\n<i>(Free mints will still execute on ALL wallets)</i>`,
    { parse_mode: 'HTML' }
  );
}

/**
 * Render Copy-Mint Wallets Sub-Menu
 */
async function handleCopyMintWalletsMenu(client, chatId, messageId, state) {
  const totalWallets = state.wallets ? state.wallets.length : 100;
  const currentRule = state.copyMintWallets || process.env.COPYMINT_WALLETS || 'all';
  const indices = parseWalletNumbers(currentRule, totalWallets);
  const formatted = formatWalletNumbers(indices, totalWallets);

  const text = [
    `💼 <b>Configure Wallets for Copy-Minting</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Current Active Wallets: <code>${formatted}</code>`,
    `\n<i>Select which burner wallets participate in whale copy-mints.</i>`,
    `\nSelect a preset below or send <code>/copymintwallets &lt;numbers&gt;</code> (e.g. <code>/copymintwallets 1, 2</code> or <code>/copymintwallets 1-5</code>):`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: 'Wallets #1, #2', callback_data: 'cm_set_copywallets:1,2' },
        { text: 'Wallets #1–#5', callback_data: 'cm_set_copywallets:1-5' }
      ],
      [
        { text: 'Wallets #1–#10', callback_data: 'cm_set_copywallets:1-10' },
        { text: 'Wallets #1–#20', callback_data: 'cm_set_copywallets:1-20' }
      ],
      [
        { text: '🌐 All Wallets (100%)', callback_data: 'cm_set_copywallets:all' }
      ],
      [
        { text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }
      ]
    ]
  };

  return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
}

/**
 * Handle /copymintwallets <numbers>
 */
async function handleSetCopyMintWallets(client, chatId, text, state) {
  const totalWallets = state.wallets ? state.wallets.length : 100;
  const parts = (text || '').trim().split(/\s+/);
  const rawRule = parts.slice(1).join(' ');

  if (!rawRule) {
    return await client.sendMessage(
      chatId,
      `⚠️ Usage: <code>/copymintwallets &lt;1, 2 | 1-5 | all&gt;</code>\nExample: <code>/copymintwallets 1, 2</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const indices = parseWalletNumbers(rawRule, totalWallets);
  const formatted = formatWalletNumbers(indices, totalWallets);

  state.copyMintWallets = rawRule;
  await client.sendMessage(
    chatId,
    `✅ <b>Copy-Mint Wallets updated to:</b> <code>${formatted}</code>.\nWhale copy-mints will now execute on these wallets.`,
    { parse_mode: 'HTML' }
  );
}

module.exports = {
  handleCopyMintMenu,
  handleCopyMintCallback,
  handleCopyMintPnL,
  handlePaidWalletsMenu,
  handleSetPaidWallets,
  handleCopyMintWalletsMenu,
  handleSetCopyMintWallets,
  handleSetMaxPrice,
  handleSetQuantity,
  handleSetGasMode,
  handleSetRecipient
};
