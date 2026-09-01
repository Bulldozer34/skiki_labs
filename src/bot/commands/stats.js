const { ethers } = require('ethers');
const MintTracker = require('../../core/mintTracker');
const { getEthPriceUsd } = require('../../utils/priceFetcher');

/**
 * Handle /stats command — NFT Mint & Sales Tracker
 * @param {object} ctx
 */
async function handleStats(ctx) {
  const { client, chatId, state } = ctx;

  const provider = state.provider;
  const feeData = await provider.getFeeData().catch(() => ({ gasPrice: ethers.parseUnits('0.1', 'gwei') }));
  const gasGwei = feeData.gasPrice ? (Number(feeData.gasPrice) / 1e9).toFixed(3) : '0.020';

  const analytics = await MintTracker.getAnalytics();
  const history = MintTracker.loadHistory();

  // Find recent real on-chain mints
  const recentMints = history
    .filter(m => !String(m.details || '').includes('Testnet Simulation') && (m.status === 'SUCCESS' || m.receipt?.status === 1))
    .slice(-4)
    .reverse();

  const lines = [
    `<b>📊 NFT Mint & Speed Performance Tracker</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<b>📦 ON-CHAIN MINT BENCHMARKS</b>`,
    `• <b>Total Successful Mints:</b> ${analytics.successCount} txs (${analytics.totalNftsMinted} NFTs)`,
    `• <b>Mint Success Rate:</b> <b>${analytics.successRatePct}%</b> (${analytics.failedCount} failed)`,
    `• <b>Avg Arrival Latency:</b> <code>${analytics.avgLatencyMs ? `${analytics.avgLatencyMs}ms` : 'N/A'}</code>`,
    `• <b>Fastest Inclusion:</b> <code>${analytics.fastestLatencyMs ? `${analytics.fastestLatencyMs}ms` : 'N/A'}</code>`,
    `• <b>Total Gas Spent:</b> <code>${analytics.totalGasEth} ETH</code> (${analytics.totalGasUsd})`,
    `• <b>Live Network Gas:</b> <code>${gasGwei} Gwei</code> (Robinhood L2)`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  // Top Collections breakdown
  if (analytics.topCollections && analytics.topCollections.length > 0) {
    lines.push(`<b>🏆 Minted Collections:</b>`);
    const top3 = analytics.topCollections.slice(0, 3);
    top3.forEach(([contract, count]) => {
      const shortAddr = contract.length > 12 ? `${contract.slice(0, 6)}...${contract.slice(-4)}` : contract;
      lines.push(`• <code>${shortAddr}</code> — <b>${count} NFT(s)</b>`);
    });
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  }

  // Recent mints with token IDs
  if (recentMints.length > 0) {
    lines.push(`<b>⚡ Recent On-Chain Drops:</b>`);
    recentMints.forEach(r => {
      const maskedW = `${(r.walletAddress || r.address || '').slice(0, 6)}...${(r.walletAddress || r.address || '').slice(-4)}`;
      const shortTx = r.txHash ? `${r.txHash.slice(0, 8)}...` : 'N/A';
      const tokenStr = r.tokenIds && r.tokenIds.length > 0 ? `Token #${r.tokenIds.join(', #')}` : 'NFT Mint';
      const latencyStr = r.mintDurationMs ? ` (${r.mintDurationMs}ms)` : '';
      lines.push(`• ${tokenStr} | Block #${r.blockNumber || 'N/A'}${latencyStr} | <code>${shortTx}</code>`);
    });
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  }

  lines.push(`<i>Send /sweep to transfer minted NFTs to your main wallet.</i>`);

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '📦 Sweep NFTs to Main Wallet', callback_data: 'cmd_sweep' },
        { text: '💰 Check Balances', callback_data: 'cmd_balance' }
      ],
      [
        { text: '🎯 Arm New Snipe', callback_data: 'cmd_snipe' },
        { text: '📥 Export History (JSON)', callback_data: 'cmd_export' }
      ]
    ]
  };

  await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle export of history
 */
async function handleExport(ctx) {
  const { client, chatId } = ctx;
  const history = MintTracker.loadHistory();

  if (history.length === 0) {
    return await client.sendMessage(chatId, '⚠️ No mint history recorded yet.');
  }

  const jsonStr = JSON.stringify(history, null, 2);
  const snippet = jsonStr.length > 3500 ? jsonStr.slice(0, 3500) + '\n... [truncated]' : jsonStr;

  await client.sendMessage(
    chatId,
    `<b>📥 Mint History Export (${history.length} records)</b>\n<pre><code>${snippet}</code></pre>`,
    { parse_mode: 'HTML' }
  );
}

module.exports = { handleStats, handleExport };
