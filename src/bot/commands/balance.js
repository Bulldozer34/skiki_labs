const { ethers } = require('ethers');
const WalletService = require('../../services/walletService');
const { getEthPriceUsd } = require('../../utils/priceFetcher');

/**
 * Handle /balance command.
 * @param {object} ctx
 */
async function handleBalance(ctx) {
  const { client, chatId, state } = ctx;

  const wallets = state.wallets || [];
  if (wallets.length === 0) {
    return await client.sendMessage(
      chatId,
      `⚠️ <b>No wallets loaded.</b>\nUse <code>/generate 5</code> to create fresh burners or check <code>wallets.txt</code>.`,
      { parse_mode: 'HTML' }
    );
  }

  // Send initial loading notice
  const statusMsg = await client.sendMessage(
    chatId,
    `⏳ <i>Fetching live balances, nonces & gas fees for ${wallets.length} wallet(s)...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const provider = state.provider;
    const ethPrice = await getEthPriceUsd().catch(() => null);
    const feeData = await provider.getFeeData().catch(() => ({ gasPrice: ethers.parseUnits('0.1', 'gwei') }));
    const gasGwei = feeData.gasPrice ? (Number(feeData.gasPrice) / 1e9).toFixed(3) : '0.020';
    const mintCostUsd = ethPrice ? ((Number(gasGwei) * 1e-9 * 200000) * ethPrice).toFixed(2) : '0.20';

    const balanceItems = await WalletService.checkDetailedBalances(wallets, provider, ethPrice || 0);

    let totalEth = 0;
    let totalUsd = 0;
    let lowCount = 0;

    const rows = balanceItems.map((item, idx) => {
      const ethNum = parseFloat(item.balanceEth);
      totalEth += ethNum;
      totalUsd += parseFloat(item.balanceUsd || '0');

      let icon = '🟢';
      if (ethNum === 0) {
        icon = '🔴';
        lowCount++;
      } else if (ethNum < 0.005) {
        icon = '🟡';
        lowCount++;
      }

      const masked = `${item.address.slice(0, 6)}...${item.address.slice(-4)}`;
      const usdStr = ethPrice ? ` ($${item.balanceUsd})` : '';
      return `${icon} <b>#${idx + 1}</b> <code>${masked}</code>: <b>${ethNum.toFixed(4)} ETH</b>${usdStr} (Tx: ${item.nonce})`;
    });

    const summaryHeader = ethPrice
      ? `Total: <b>${totalEth.toFixed(4)} ETH</b> (~$${totalUsd.toFixed(2)} USD)`
      : `Total: <b>${totalEth.toFixed(4)} ETH</b>`;

    const text = [
      `<b>💰 Live Wallet Balances & Nonces</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💼 <b>Wallets Checked:</b> ${wallets.length}`,
      `💵 ${summaryHeader}`,
      `⛽ <b>Live Gas:</b> <code>${gasGwei} Gwei (~$${mintCostUsd} USD / mint)</code>`,
      ...(lowCount > 0 ? [`⚠️ <b>Low/Empty Wallets:</b> ${lowCount}`] : []),
      `━━━━━━━━━━━━━━━━━━━━`,
      ...rows,
      `━━━━━━━━━━━━━━━━━━━━`,
      lowCount > 0
        ? `<i>Tip: Use <code>/fund 0.005</code> to fund low wallets from your master key.</i>`
        : `<i>All wallets funded and ready for drop execution.</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '💸 Auto-Fund (0.005 ETH)', callback_data: 'fund_batch:0.005' },
          { text: '📦 Sweep Assets', callback_data: 'cmd_sweep' }
        ],
        [
          { text: '🎯 Arm Drop (/snipe)', callback_data: 'cmd_snipe' },
          { text: '🔄 Refresh Balances', callback_data: 'cmd_balance' }
        ]
      ]
    };

    if (statusMsg?.message_id) {
      await client.editMessageText(chatId, statusMsg.message_id, text, { parse_mode: 'HTML', reply_markup });
    } else {
      await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
    }
  } catch (err) {
    await client.sendMessage(chatId, `❌ Failed to fetch balances: ${err.message}`);
  }
}

module.exports = { handleBalance };
