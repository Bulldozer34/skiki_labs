const { ethers } = require('ethers');
const WalletService = require('../../services/walletService');
const logger = require('../../utils/logger');

function getMasterKey() {
  return (
    process.env.MASTER_WALLET_PRIVATE_KEY ||
    process.env.MASTER_PRIVATE_KEY ||
    process.env.FUNDING_PRIVATE_KEY ||
    ''
  ).trim();
}

/**
 * Handle /fund command (e.g. `/fund 0.01` or via inline button).
 * @param {object} ctx
 * @param {string[]} ctx.args
 */
async function handleFund(ctx) {
  const { client, chatId, args, state } = ctx;

  const masterKey = getMasterKey();
  if (!masterKey) {
    return await client.sendMessage(
      chatId,
      [
        `⚠️ <b>Master Wallet Not Configured</b>`,
        `To use auto-funding, set <code>MASTER_WALLET_PRIVATE_KEY=0x...</code> in your <code>.env</code> file on the server.`,
        ``,
        `<i>Alternatively, send ETH manually to your public burner addresses.</i>`
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }

  const wallets = state.wallets || [];
  if (wallets.length === 0) {
    return await client.sendMessage(
      chatId,
      `⚠️ No wallets loaded to fund. Use <code>/generate 5</code> first.`,
      { parse_mode: 'HTML' }
    );
  }

  let amountEth = '0.005';
  if (args && args.length > 0) {
    const parsed = parseFloat(args[0]);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 1.0) {
      amountEth = args[0];
    }
  }

  const amountWeiEach = ethers.parseEther(amountEth);
  const totalEthNeeded = (parseFloat(amountEth) * wallets.length).toFixed(4);

  let masterWallet;
  try {
    masterWallet = new ethers.Wallet(masterKey);
  } catch (err) {
    return await client.sendMessage(chatId, `❌ Invalid MASTER_WALLET_PRIVATE_KEY in .env: ${err.message}`);
  }

  const provider = state.provider;
  const masterBal = await provider.getBalance(masterWallet.address);
  const masterBalEth = ethers.formatEther(masterBal);

  if (parseFloat(masterBalEth) < parseFloat(totalEthNeeded)) {
    return await client.sendMessage(
      chatId,
      [
        `❌ <b>Insufficient Master Wallet Balance</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Master: <code>${masterWallet.address.slice(0, 6)}...${masterWallet.address.slice(-4)}</code>`,
        `Available: <b>${parseFloat(masterBalEth).toFixed(4)} ETH</b>`,
        `Required: <b>${totalEthNeeded} ETH</b> (${wallets.length} × ${amountEth} ETH)`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `<i>Please fund your master wallet and try again.</i>`
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }

  const statusMsg = await client.sendMessage(
    chatId,
    `🚀 <b>Initiating auto-funding for ${wallets.length} wallet(s)...</b>\nSending <b>${amountEth} ETH</b> each from Master (<code>${masterWallet.address.slice(0, 6)}...</code>)`,
    { parse_mode: 'HTML' }
  );

  try {
    const targetAddresses = wallets.map(w => w.address);
    const results = await WalletService.fundWallets(masterWallet, targetAddresses, amountWeiEach, provider);

    const successCount = results.filter(r => r.status === 'SUCCESS').length;
    const failCount = results.length - successCount;

    const lines = [
      `<b>💸 Auto-Funding Completed</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `✅ <b>Successful:</b> ${successCount}/${wallets.length}`,
      ...(failCount > 0 ? [`❌ <b>Failed:</b> ${failCount}`] : []),
      `💵 <b>Funded Amount:</b> ${amountEth} ETH per wallet`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>Transaction Receipts:</b>`
    ];

    results.forEach((r, idx) => {
      const masked = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
      if (r.status === 'SUCCESS') {
        const txShort = r.txHash ? `${r.txHash.slice(0, 10)}...` : 'OK';
        lines.push(`• #${idx + 1} <code>${masked}</code>: ✅ Block #${r.blockNumber} (<code>${txShort}</code>)`);
      } else {
        lines.push(`• #${idx + 1} <code>${masked}</code>: ❌ ${r.error || 'Failed'}`);
      }
    });

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`<i>Send /balance to verify wallet states.</i>`);

    if (statusMsg?.message_id) {
      await client.editMessageText(chatId, statusMsg.message_id, lines.join('\n'), { parse_mode: 'HTML' });
    } else {
      await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
    }
  } catch (err) {
    await client.sendMessage(chatId, `❌ Error during funding: ${err.message}`);
  }
}

module.exports = { handleFund };
