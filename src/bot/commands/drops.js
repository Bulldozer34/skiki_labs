/**
 * Format remaining seconds to human-readable duration
 * @param {number} sec
 * @returns {string}
 */
function formatDuration(sec) {
  if (sec <= 0) return 'Immediate / Ready';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Handle /drops and /scheduled commands.
 * Lists all active background scheduled drops with countdowns and cancel buttons.
 * @param {object} ctx
 */
async function handleDrops(ctx) {
  const { client, chatId, state } = ctx;

  const activeSnipes = state.activeSnipes || new Map();
  if (activeSnipes.size === 0) {
    const text = [
      `<b>🎯 Active Scheduled Drops (0)</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `No drops currently scheduled in the background.`,
      ``,
      `<i>Use <code>/snipe &lt;slug/address&gt;</code> to schedule a drop.</i>`
    ].join('\n');

    return await client.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  const lines = [
    `<b>🎯 Active Scheduled Drops (${activeSnipes.size})</b>`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  const inline_keyboard = [];
  const nowSec = Math.floor(Date.now() / 1000);

  let idx = 1;
  for (const [id, drop] of activeSnipes.entries()) {
    const timeRemaining = drop.startTime ? Math.max(0, drop.startTime - nowSec) : 0;
    const timeStr = drop.startTime
      ? `${new Date(drop.startTime * 1000).toLocaleTimeString()} (in ${formatDuration(timeRemaining)})`
      : 'Immediate Execution';

    const shortTarget = drop.collectionName
      ? `${drop.collectionName}`
      : (drop.target && drop.target.length > 20
          ? `${drop.target.slice(0, 8)}...${drop.target.slice(-6)}`
          : drop.target);

    const contractLine = drop.contractAddress ? `• <b>Contract:</b> <code>${drop.contractAddress}</code>` : null;

    lines.push(`<b>#${idx}: ${shortTarget}</b>`);
    if (contractLine) lines.push(contractLine);
    lines.push(`• <b>Chain:</b> ${drop.chainKey} | <b>Mode:</b> ${drop.mode}`);
    lines.push(`• <b>Quantity:</b> ${drop.quantity} NFT(s) per wallet`);
    lines.push(`• <b>Starts:</b> ${timeStr}`);
    lines.push(`• <b>Status:</b> ⏳ <i>Armed & Monitoring Drop Window</i>`);
    lines.push(``);

    inline_keyboard.push([
      { text: `❌ Cancel #${idx} (${shortTarget.slice(0, 16)})`, callback_data: `drop_cancel:${id}` }
    ]);

    idx++;
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>The daemon will automatically execute each drop at its scheduled window.</i>`);

  await client.sendMessage(chatId, lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard }
  });
}

/**
 * Handle drop cancellation callback from Telegram inline button
 */
async function handleDropCancel(ctx, dropId) {
  const { client, chatId, callbackQuery, state } = ctx;

  const activeSnipes = state.activeSnipes || new Map();
  const drop = activeSnipes.get(dropId);

  if (!drop) {
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Drop not found or already executed.', show_alert: true });
    return;
  }

  // Trigger abort if controller exists
  if (drop.abortController) {
    try { drop.abortController.abort(); } catch (e) {}
  }

  activeSnipes.delete(dropId);
  await client.answerCallbackQuery(callbackQuery.id, { text: 'Drop cancelled successfully.' });

  await client.sendMessage(
    chatId,
    `🛑 <b>Scheduled Drop Cancelled</b>\nTarget: <code>${drop.target}</code> (${drop.chainKey}) was removed from the active queue.`,
    { parse_mode: 'HTML' }
  );
}

module.exports = {
  handleDrops,
  handleDropCancel
};
