/**
 * /track & /tracked Command Handlers — Whale Wallet Tracking Management.
 */

const { ethers } = require('ethers');
const trackedWalletService = require('../../services/trackedWalletService');

/**
 * Handle /track <address> [label]
 */
async function handleTrack(client, chatId, text) {
  const parts = (text || '').trim().split(/\s+/);
  // parts[0] is /track
  const address = parts[1];
  const label = parts.slice(2).join(' ');

  if (!address || !ethers.isAddress(address)) {
    const errorMsg = [
      `⚠️ <b>Invalid Address</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Usage: <code>/track &lt;0xAddress&gt; [Optional Label]</code>`,
      `Example: <code>/track 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 Vitalik</code>`
    ].join('\n');
    return await client.sendMessage(chatId, errorMsg, { parse_mode: 'HTML' });
  }

  try {
    const entry = trackedWalletService.addWallet(address, label);
    const msg = [
      `✅ <b>Whale Wallet Added to Tracker!</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🏷️ <b>Label:</b> <code>${entry.label}</code>`,
      `💼 <b>Address:</b> <code>${entry.address}</code>`,
      `🟢 <b>Status:</b> Active monitoring (Mempool + Blocks)`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>The bot will now automatically detect and copy mints initiated by this wallet.</i>`
    ].join('\n');

    await client.sendMessage(chatId, msg, { parse_mode: 'HTML' });
  } catch (err) {
    await client.sendMessage(chatId, `❌ <b>Error:</b> ${err.message}`, { parse_mode: 'HTML' });
  }
}

/**
 * Handle /untrack <address>
 */
async function handleUntrack(client, chatId, text) {
  const parts = (text || '').trim().split(/\s+/);
  const address = parts[1];

  if (!address) {
    return await client.sendMessage(
      chatId,
      `Usage: <code>/untrack &lt;0xAddress&gt;</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const removed = trackedWalletService.removeWallet(address);
  if (removed) {
    await client.sendMessage(
      chatId,
      `🗑️ <b>Removed from Tracker:</b> <code>${address}</code>`,
      { parse_mode: 'HTML' }
    );
  } else {
    await client.sendMessage(
      chatId,
      `⚠️ <b>Wallet was not found in tracker:</b> <code>${address}</code>`,
      { parse_mode: 'HTML' }
    );
  }
}

/**
 * Handle /tracked (List all tracked wallets with inline management)
 */
async function handleTracked(client, chatId, messageId = null) {
  const wallets = trackedWalletService.getWallets();

  if (wallets.length === 0) {
    const text = [
      `📋 <b>Tracked Whale Wallets</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>No whale wallets currently tracked.</i>`,
      `Add one using: <code>/track &lt;address&gt; [label]</code>`,
      `Or use the scout engine to import top profitable wallets.`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [{ text: '◀️ Back to Menu', callback_data: 'menu_copymint' }]
      ]
    };

    if (messageId) {
      return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
    }
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  }

  const lines = [
    `📋 <b>Tracked Whale Wallets (${wallets.length})</b>`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  const keyboard = [];

  wallets.forEach((w, idx) => {
    const statusEmoji = w.active !== false ? '🟢' : '🔴';
    lines.push(`${idx + 1}. ${statusEmoji} <b>${w.label || 'Whale'}</b>`);
    lines.push(`   <code>${w.address}</code>`);

    keyboard.push([
      { text: `${w.active !== false ? '⏸️ Pause' : '▶️ Resume'} ${w.label || idx + 1}`, callback_data: `tw_toggle_${w.address}` },
      { text: `🗑️ Remove`, callback_data: `tw_remove_${w.address}` }
    ]);
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Tap a button below to pause or remove a tracked whale.</i>`);

  keyboard.push([{ text: '◀️ Back to Copy-Mint Menu', callback_data: 'menu_copymint' }]);

  const text = lines.join('\n');
  const reply_markup = { inline_keyboard: keyboard };

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
  return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle Tracked Wallet Callback Queries
 */
async function handleTrackCallback(client, chatId, messageId, data) {
  if (data.startsWith('tw_toggle_')) {
    const address = data.replace('tw_toggle_', '');
    try {
      trackedWalletService.toggleActive(address);
    } catch {}
    return await handleTracked(client, chatId, messageId);
  }

  if (data.startsWith('tw_remove_')) {
    const address = data.replace('tw_remove_', '');
    trackedWalletService.removeWallet(address);
    return await handleTracked(client, chatId, messageId);
  }
}

module.exports = {
  handleTrack,
  handleUntrack,
  handleTracked,
  handleTrackCallback
};
