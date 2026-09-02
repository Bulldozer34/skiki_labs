const os = require('os');
const { ethers } = require('ethers');
const MintTracker = require('../../core/mintTracker');
const { getEthPriceUsd } = require('../../utils/priceFetcher');

/**
 * Format uptime seconds into human readable string.
 * @param {number} sec
 * @returns {string}
 */
function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

/**
 * Handle /status command.
 * @param {object} ctx
 */
async function handleStatus(ctx) {
  const { client, chatId, state } = ctx;

  const uptimeStr = formatUptime(Math.floor((Date.now() - state.startTimeMs) / 1000));
  const memoryMb = (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1);
  const totalWallets = state.wallets ? state.wallets.length : 0;
  const activeSnipes = state.activeSnipes ? state.activeSnipes.size : 0;

  const provider = state.provider;
  const ethPrice = await getEthPriceUsd().catch(() => 2400);
  const feeData = await provider.getFeeData().catch(() => ({ gasPrice: ethers.parseUnits('0.1', 'gwei') }));
  const gasGwei = feeData.gasPrice ? (Number(feeData.gasPrice) / 1e9).toFixed(3) : '0.020';
  const mintGasCostUsd = ((Number(gasGwei) * 1e-9 * 200000) * ethPrice).toFixed(2);

  const analytics = await MintTracker.getAnalytics().catch(() => null);
  const avgLatency = analytics?.avgLatencyMs ? `${analytics.avgLatencyMs}ms` : 'N/A';
  const successRate = analytics ? `${analytics.successRatePct}%` : '100%';

  const text = [
    `<b>🤖 NFT Mint Bot — Daemon Health & Telemetry</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🟢 <b>Daemon Status:</b> Active & Running 24/7`,
    `⏱️ <b>Uptime:</b> ${uptimeStr}`,
    `💼 <b>Active Wallets:</b> ${totalWallets}`,
    `🎯 <b>Active Scheduled Drops:</b> ${activeSnipes}`,
    `⛽ <b>Network Gas:</b> <code>${gasGwei} Gwei (~$${mintGasCostUsd} USD / mint)</code>`,
    `⚡ <b>Avg Block Inclusion:</b> <code>${avgLatency}</code> (Rate: ${successRate})`,
    `🧠 <b>RAM Usage:</b> ${memoryMb} MB`,
    `🔗 <b>Default Route:</b> Sequencer Direct (Robinhood 4663)`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Send /snipe to arm a drop or /sweep to consolidate assets.</i>`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🎯 Arm Snipe', callback_data: 'cmd_snipe' },
        { text: '💰 Balances', callback_data: 'cmd_balance' }
      ],
      [
        { text: '📊 Full Stats', callback_data: 'cmd_stats' },
        { text: '📦 Sweep Assets', callback_data: 'cmd_sweep' }
      ]
    ]
  };

  await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
}

module.exports = { handleStatus };
