const { riskManager } = require('../../core/riskManager');

/**
 * Handle /limits command.
 * @param {object} ctx
 */
async function handleLimits(ctx) {
  const { client, chatId } = ctx;

  const status = riskManager.getStatus();
  const caps = status.caps;

  const spentPct = caps.dailyBudgetUsd > 0
    ? Math.min(100, Math.round((status.spentTodayUsd / caps.dailyBudgetUsd) * 100))
    : 0;

  // Visual progress bar for daily budget (10 blocks)
  const filledBlocks = Math.round(spentPct / 10);
  const emptyBlocks = 10 - filledBlocks;
  const progressBar = '🟩'.repeat(filledBlocks) + '⬜'.repeat(emptyBlocks);

  const text = [
    `<b>🛡️ Risk & Budget Controls</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📅 <b>UTC Date:</b> ${status.dateUtc}`,
    `💰 <b>Daily Budget:</b> $${status.spentTodayUsd.toFixed(2)} / $${caps.dailyBudgetUsd.toFixed(2)} (${spentPct}%)`,
    `${progressBar}`,
    `💵 <b>Remaining Today:</b> $${status.remainingBudgetUsd.toFixed(2)}`,
    ``,
    `<b>🔒 Risk Caps:</b>`,
    `• Max Price per NFT: <b>$${caps.maxPriceUsd.toFixed(2)}</b> (Higher requires confirm)`,
    `• Max per Collection: <b>${caps.maxPerCollection} NFT(s)</b>`,
    `• Max Slippage: <b>${caps.maxSlippagePct}%</b>`,
    `• Take-Profit Target: <b>+${caps.takeProfitPct}%</b>`,
    `• Stop-Loss Trigger: <b>-${caps.stopLossPct}%</b>`,
    `• Whale Conviction Filter: <b>≥${caps.whaleConviction} items</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Transactions Today: ${status.transactionsToday} across ${status.collectionsToday} collection(s)</i>`
  ].join('\n');

  await client.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

module.exports = { handleLimits };
