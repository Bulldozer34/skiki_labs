/**
 * /copymint Command & Sub-Menu Handler — Real-time Copy-Mint Controls.
 */

const trackedWalletService = require('../../services/trackedWalletService');

/**
 * Render the Copy-Mint Remote Control Sub-Menu
 */
async function handleCopyMintMenu(client, chatId, messageId = null, state = {}) {
  const isAutomintEnabled = state.automintEnabled !== false;
  const trackedWallets = trackedWalletService.getWallets();
  const activeTrackedCount = trackedWalletService.getActiveAddressesSet().size;
  const maxMintEth = state.maxMintEth || process.env.MAX_MINT_ETH || '0.05';
  const trackerStats = state.trackerEngine ? state.trackerEngine.getStats() : { mintsDetected: 0, wsConnected: false };

  const text = [
    `⚡ <b>COPY-MINT & WHALE TRACKER</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🤖 <b>Auto-Mint Engine:</b> ${isAutomintEnabled ? '🟢 ENABLED (24/7 Snipe)' : '🔴 PAUSED'}`,
    `🐋 <b>Tracked Whales:</b> <code>${activeTrackedCount}</code> active (${trackedWallets.length} total)`,
    `💰 <b>Max Price Cap:</b> <code>${maxMintEth} ETH</code> per wallet`,
    `📡 <b>Mempool WS:</b> ${trackerStats.wsConnected ? '🟢 Connected' : '🟡 HTTP Block Mode'}`,
    `🎯 <b>Total Whale Mints Detected:</b> <code>${trackerStats.mintsDetected || 0}</code>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Select an action below:</i>`
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
        { text: `📋 View Tracked Whales (${activeTrackedCount})`, callback_data: 'cmd_tracked' },
        { text: '➕ Add Whale', callback_data: 'cm_add_whale_prompt' }
      ],
      [
        { text: '📊 Tracker Stats', callback_data: 'cm_stats' },
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
 * Handle Copy-Mint Callback Queries
 */
async function handleCopyMintCallback(client, chatId, messageId, data, state = {}) {
  if (data === 'cm_toggle_automint') {
    state.automintEnabled = !(state.automintEnabled !== false);
    return await handleCopyMintMenu(client, chatId, messageId, state);
  }

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

module.exports = {
  handleCopyMintMenu,
  handleCopyMintCallback
};
