const { ethers } = require('ethers');
const logger = require('../../utils/logger');

/**
 * Handle /recipient command in Telegram
 */
async function handleRecipient(ctx) {
  const { client, chatId, state } = ctx;
  const currentRecipient = state.recipientAddress || process.env.RECIPIENT_ADDRESS;

  const lines = [
    `📬 <b>RECIPIENT / CONSOLIDATION WALLET</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    currentRecipient
      ? `Current Recipient: <code>${currentRecipient}</code>\n\n<i>All copy-minted or forwarded NFTs will be automatically swept into this address.</i>`
      : `No recipient address configured.\n\n<i>Minted NFTs will remain in their respective minting burner wallets.</i>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `To set or change your recipient wallet, send:\n<code>/setrecipient 0xYourWalletAddress</code>`
  ];

  const inline_keyboard = [];
  if (currentRecipient) {
    inline_keyboard.push([
      { text: '🗑️ Clear Recipient', callback_data: 'recipient_clear' }
    ]);
  }
  inline_keyboard.push([
    { text: '◀️ Back to Dashboard', callback_data: 'menu_back' }
  ]);

  return await client.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

/**
 * Handle /setrecipient <address> command in Telegram
 */
async function handleSetRecipient(ctx) {
  const { client, chatId, args, state } = ctx;
  const target = (args && args[0] ? args[0] : '').trim();

  if (!target) {
    return await client.sendMessage(
      chatId,
      `⚠️ <b>Usage:</b> <code>/setrecipient 0xYourWalletAddress</code>\n\nPlease provide a valid Ethereum/EVM 0x wallet address.`,
      { parse_mode: 'HTML' }
    );
  }

  if (!ethers.isAddress(target)) {
    return await client.sendMessage(
      chatId,
      `❌ <b>Invalid Address:</b> <code>${target}</code> is not a valid 20-byte EVM address.\n\nExample:\n<code>/setrecipient 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045</code>`,
      { parse_mode: 'HTML' }
    );
  }

  const checksummed = ethers.getAddress(target);
  state.recipientAddress = checksummed;

  return await client.sendMessage(
    chatId,
    [
      `✅ <b>Recipient Wallet Configured!</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Target: <code>${checksummed}</code>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>All future forwarded drops and copy-mints will consolidate into this wallet.</i>`
    ].join('\n'),
    { parse_mode: 'HTML' }
  );
}

/**
 * Handle recipient callback queries
 */
async function handleRecipientCallback(ctx, action) {
  const { client, callbackQuery, state } = ctx;

  if (action === 'clear') {
    state.recipientAddress = null;
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Recipient cleared.' });
    return await client.editMessageText(
      callbackQuery.message.chat.id,
      callbackQuery.message.message_id,
      `🗑️ <b>Recipient address cleared.</b> Minted NFTs will now remain in their minting wallets.`,
      { parse_mode: 'HTML' }
    );
  }
}

module.exports = {
  handleRecipient,
  handleSetRecipient,
  handleRecipientCallback
};
