const { ethers } = require('ethers');
const { getEthPriceUsd } = require('../../utils/priceFetcher');
const logger = require('../../utils/logger');

/**
 * Handle /gas Telegram Command
 * @param {object} ctx Context from telegramBot.js
 */
async function handleGas(ctx) {
  const { client, chatId, state, messageId } = ctx;

  try {
    const provider = state?.provider || new ethers.JsonRpcProvider(process.env.QUICKNODE_URL || 'https://rpc.mainnet.chain.robinhood.com');
    const feeData = await provider.getFeeData();
    const ethPrice = await getEthPriceUsd().catch(() => 2500) || 2500;

    const baseFeeGwei = feeData.maxFeePerGas ? parseFloat(ethers.formatUnits(feeData.maxFeePerGas, 'gwei')) : 0.1;
    const priorityTipGwei = feeData.maxPriorityFeePerGas ? parseFloat(ethers.formatUnits(feeData.maxPriorityFeePerGas, 'gwei')) : 0.05;

    // Presets
    const turboTip = Math.max(0.1, priorityTipGwei * 1.5);
    const warTip = Math.max(0.3, priorityTipGwei * 3.0);

    // Calculate USD per mint (~200k gas)
    const gasLimit = 200000;
    const calcCost = (baseGwei, tipGwei) => {
      const totalGwei = baseGwei + tipGwei;
      const totalEth = (totalGwei * 1e-9) * gasLimit;
      const totalUsd = totalEth * ethPrice;
      return {
        eth: totalEth.toFixed(6),
        usd: totalUsd < 0.01 ? `< $0.01` : `$${totalUsd.toFixed(3)}`
      };
    };

    const standardCost = calcCost(baseFeeGwei, priorityTipGwei);
    const turboCost = calcCost(baseFeeGwei, turboTip);
    const warCost = calcCost(baseFeeGwei, warTip);

    const congestion = baseFeeGwei > 1.0 ? '🔴 High (Congested)' : (baseFeeGwei > 0.3 ? '🟡 Moderate' : '🟢 Low (Optimal)');

    const text = [
      `⛽ <b>ROBINHOOD CHAIN LIVE GAS TELEMETRY</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `⚡ <b>Base Fee:</b> <code>${baseFeeGwei.toFixed(3)} Gwei</code>`,
      `🌐 <b>Network Congestion:</b> ${congestion}`,
      `💵 <b>ETH Price:</b> <code>$${ethPrice.toLocaleString()}</code>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>Estimated Cost Per Mint (200k Gas):</b>`,
      `• <b>Standard:</b> <code>${baseFeeGwei.toFixed(2)} Gwei</code> (~${standardCost.usd} USD / ${standardCost.eth} ETH)`,
      `• <b>Turbo (Default):</b> <code>${(baseFeeGwei + turboTip).toFixed(2)} Gwei</code> (~${turboCost.usd} USD / ${turboCost.eth} ETH) ⚡`,
      `• <b>War Mode:</b> <code>${(baseFeeGwei + warTip).toFixed(2)} Gwei</code> (~${warCost.usd} USD / ${warCost.eth} ETH) 🔥`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>Robinhood L2 offers sub-penny execution. Free mints cost pennies across 50+ wallets!</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '🔄 Refresh Gas', callback_data: 'cmd_gas_refresh' },
          { text: '⚙️ Change Gas Mode', callback_data: 'cm_menu_gas' }
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
  } catch (err) {
    logger.error(`[Gas] Failed to fetch gas data: ${err.message}`);
    return await client.sendMessage(chatId, `❌ Failed to fetch live gas: ${err.message}`, { parse_mode: 'HTML' });
  }
}

module.exports = { handleGas };
