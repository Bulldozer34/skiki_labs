const { ethers } = require('ethers');
const SweepService = require('../../services/sweepService');
const WalletService = require('../../services/walletService');
const logger = require('../../utils/logger');

// In-memory sweep wizard state: chatId -> { step, data, expiresAt }
const activeSweepWizards = new Map();

/**
 * Handle /sweep command
 * @param {object} ctx
 */
async function handleSweep(ctx) {
  const { client, chatId, state } = ctx;
  const wallets = state.wallets || [];

  if (wallets.length === 0) {
    return await client.sendMessage(
      chatId,
      `⚠️ <b>No wallets loaded.</b> Use <code>/generate 5</code> to create wallets or check <code>wallets.txt</code>.`,
      { parse_mode: 'HTML' }
    );
  }

  const provider = state.provider;
  const feeData = await provider.getFeeData().catch(() => ({ gasPrice: ethers.parseUnits('0.1', 'gwei') }));
  const gasGwei = feeData.gasPrice ? (Number(feeData.gasPrice) / 1e9).toFixed(3) : '0.020';

  const statusMsg = await client.sendMessage(
    chatId,
    `⏳ <i>Scanning ${wallets.length} burner wallet(s) for owned NFTs & drainable ETH balance...</i>\n⛽ <b>Live Gas:</b> <code>${gasGwei} Gwei</code>`,
    { parse_mode: 'HTML' }
  );

  try {
    const ownedNfts = await SweepService.scanBurnerNfts(wallets, provider);

    // Calculate total drainable ETH using Multicall3 single-RPC batch query
    const balanceRecords = await WalletService.checkBalances(wallets, provider).catch(() => []);
    let totalEthBalance = 0;
    for (const b of balanceRecords) {
      totalEthBalance += parseFloat(b.balance || '0');
    }

    const wizardState = {
      step: 'SELECT_ITEMS',
      data: {
        ownedNfts,
        totalEthBalance,
        selectedItems: [],
        drainEth: false,
        recipient: process.env.RECIPIENT_ADDRESS || null
      },
      expiresAt: Date.now() + 180000
    };
    activeSweepWizards.set(String(chatId), wizardState);

    // Group NFTs by collection
    const byCollection = new Map();
    ownedNfts.forEach(item => {
      const list = byCollection.get(item.contract) || [];
      list.push(item);
      byCollection.set(item.contract, list);
    });

    const keyboard = [];

    if (ownedNfts.length > 0) {
      keyboard.push([
        { text: `⚡ Sweep ALL NFTs (${ownedNfts.length} tokens)`, callback_data: 'sweep_sel:ALL' }
      ]);

      // By Collection buttons
      for (const [contract, list] of byCollection.entries()) {
        const name = list[0]?.name || 'Collection';
        const shortAddr = `${contract.slice(0, 6)}...${contract.slice(-4)}`;
        keyboard.push([
          { text: `🖼️ "${name}" (${list.length} NFTs)`, callback_data: `sweep_sel:COL_${contract}` }
        ]);
      }

      // Individual Token buttons (up to 4)
      for (let i = 0; i < Math.min(ownedNfts.length, 4); i++) {
        const item = ownedNfts[i];
        keyboard.push([
          { text: `🔢 Token #${item.tokenId} (Wallet #${item.walletIndex + 1})`, callback_data: `sweep_sel:TOKEN_${item.contract}_${item.tokenId}` }
        ]);
      }
    }

    if (totalEthBalance > 0.0001) {
      keyboard.push([
        { text: `💸 Drain Leftover ETH (${totalEthBalance.toFixed(4)} ETH)`, callback_data: 'sweep_sel:ETH' }
      ]);
    }

    if (ownedNfts.length > 0 && totalEthBalance > 0.0001) {
      keyboard.push([
        { text: `⚡ Sweep ALL NFTs + Drain ETH`, callback_data: 'sweep_sel:ALL_WITH_ETH' }
      ]);
    }

    keyboard.push([{ text: '❌ Cancel', callback_data: 'sweep_cancel' }]);

    const text = [
      `<b>📦 Wallet Sweeper & Consolidation Tool</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💼 <b>Loaded Burners:</b> ${wallets.length}`,
      `🖼️ <b>NFTs Found on Burners:</b> <b>${ownedNfts.length}</b> token(s)`,
      `💰 <b>Drainable ETH:</b> <b>${totalEthBalance.toFixed(4)} ETH</b>`,
      `⛽ <b>Network Gas:</b> <code>${gasGwei} Gwei</code>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ownedNfts.length === 0 && totalEthBalance <= 0.0001
        ? `<i>No NFTs or drainable funds found on active burners.</i>`
        : `<i>Select what you would like to sweep to your main wallet:</i>`
    ].join('\n');

    if (statusMsg?.message_id) {
      await client.editMessageText(chatId, statusMsg.message_id, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    } else {
      await client.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard }
      });
    }
  } catch (err) {
    await client.sendMessage(chatId, `❌ Sweep scan failed: ${err.message}`);
  }
}

/**
 * Handle sweep callbacks
 */
async function handleSweepCallback(ctx, param) {
  const { client, chatId, callbackQuery, state } = ctx;
  const wizard = activeSweepWizards.get(String(chatId));

  if (param === 'cancel') {
    activeSweepWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Sweep cancelled.' });
    return await client.editMessageText(chatId, callbackQuery.message.message_id, '❌ <i>Sweep cancelled.</i>', { parse_mode: 'HTML' });
  }

  if (!wizard || Date.now() > wizard.expiresAt) {
    activeSweepWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Sweep session expired. Run /sweep again.', show_alert: true });
    return;
  }

  // 1. Resolve selected items
  const allNfts = wizard.data.ownedNfts || [];
  let selected = [];
  let drainEth = false;
  let label = '';

  if (param === 'ALL') {
    selected = [...allNfts];
    label = `All ${selected.length} NFTs`;
  } else if (param === 'ALL_WITH_ETH') {
    selected = [...allNfts];
    drainEth = true;
    label = `All ${selected.length} NFTs + Drain ETH`;
  } else if (param === 'ETH') {
    drainEth = true;
    label = `Drain Leftover ETH (${wizard.data.totalEthBalance.toFixed(4)} ETH)`;
  } else if (param.startsWith('COL_')) {
    const contract = param.replace('COL_', '').toLowerCase();
    selected = allNfts.filter(item => item.contract.toLowerCase() === contract);
    const name = selected[0]?.name || 'Selected Collection';
    label = `Collection "${name}" (${selected.length} NFTs)`;
  } else if (param.startsWith('TOKEN_')) {
    const parts = param.split('_');
    const contract = parts[1].toLowerCase();
    const tokenId = parts[2];
    selected = allNfts.filter(item => item.contract.toLowerCase() === contract && item.tokenId === tokenId);
    label = `Token #${tokenId}`;
  }

  wizard.data.selectedItems = selected;
  wizard.data.drainEth = drainEth;
  wizard.data.selectionLabel = label;
  wizard.step = 'CONFIRM_RECIPIENT';

  await client.answerCallbackQuery(callbackQuery.id);

  // Check if RECIPIENT_ADDRESS exists in environment
  const envRecipient = (process.env.RECIPIENT_ADDRESS || '').trim();
  const keyboard = [];

  if (envRecipient && ethers.isAddress(envRecipient)) {
    const masked = `${envRecipient.slice(0, 6)}...${envRecipient.slice(-4)}`;
    keyboard.push([
      { text: `🚀 Send to Main Wallet (${masked})`, callback_data: `sweep_exec:${envRecipient}` }
    ]);
  }

  keyboard.push([
    { text: '✏️ Enter Custom Destination Address', callback_data: 'sweep_custom_dest' }
  ]);
  keyboard.push([{ text: '❌ Cancel', callback_data: 'sweep_cancel' }]);

  const text = [
    `<b>📦 Step 2/2 — Confirm Destination Wallet</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Selected: <b>${label}</b>`,
    ``,
    `Where should the bot send the swept assets?`
  ].join('\n');

  return await client.editMessageText(chatId, callbackQuery.message.message_id, text, {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: keyboard }
  });
}

/**
 * Handle execution of sweep
 */
async function executeSweep(ctx, recipientAddress, messageId = null) {
  const { client, chatId, state } = ctx;
  const wizard = activeSweepWizards.get(String(chatId));

  if (!wizard) return;
  activeSweepWizards.delete(String(chatId));

  const wallets = state.wallets || [];
  const provider = state.provider;
  const { selectedItems, drainEth, selectionLabel } = wizard.data;

  const maskedDest = `${recipientAddress.slice(0, 6)}...${recipientAddress.slice(-4)}`;

  const progressMsg = messageId
    ? await client.editMessageText(
        chatId,
        messageId,
        `🚀 <b>Sweeping Assets to ${maskedDest}...</b>\nTransferring ${selectionLabel}...`,
        { parse_mode: 'HTML' }
      )
    : await client.sendMessage(
        chatId,
        `🚀 <b>Sweeping Assets to ${maskedDest}...</b>\nTransferring ${selectionLabel}...`,
        { parse_mode: 'HTML' }
      );

  const lines = [
    `<b>🎉 Sweep & Consolidation Complete!</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🎯 <b>Destination:</b> <code>${recipientAddress}</code>`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  // 1. Transfer NFTs
  if (selectedItems && selectedItems.length > 0) {
    const nftResults = await SweepService.transferNfts(wallets, recipientAddress, selectedItems, provider);
    const successNfts = nftResults.filter(r => r.status === 'SUCCESS').length;

    lines.push(`<b>🖼️ NFT Transfers (${successNfts}/${selectedItems.length}):</b>`);
    nftResults.forEach(r => {
      const shortTx = r.txHash ? `${r.txHash.slice(0, 8)}...` : 'N/A';
      if (r.status === 'SUCCESS') {
        lines.push(`• #${r.tokenId} (${r.name}): ✅ Block #${r.blockNumber} (<code>${shortTx}</code>)`);
      } else {
        lines.push(`• #${r.tokenId} (${r.name}): ❌ ${r.error}`);
      }
    });
    lines.push(``);
  }

  // 2. Drain ETH
  if (drainEth) {
    const ethResults = await SweepService.drainEth(wallets, recipientAddress, provider);
    const successEth = ethResults.filter(r => r.status === 'SUCCESS');
    let totalDrainedEth = 0;
    successEth.forEach(r => { totalDrainedEth += parseFloat(r.amountEth || '0'); });

    lines.push(`<b>💸 ETH Balance Drain:</b>`);
    lines.push(`• <b>Total Drained:</b> <b>${totalDrainedEth.toFixed(5)} ETH</b> from ${successEth.length} wallet(s)`);
    successEth.forEach((r, idx) => {
      const maskedW = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
      lines.push(`• #${idx + 1} <code>${maskedW}</code>: ✅ ${r.amountEth} ETH (Block #${r.blockNumber})`);
    });
  }

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Send /balance to verify refreshed wallet funds.</i>`);

  await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

/**
 * Handle pending text inputs for sweep (custom destination address)
 */
function handleSweepPendingInput(ctx) {
  const wizard = activeSweepWizards.get(String(ctx.chatId));
  if (!wizard || wizard.step !== 'AWAIT_DESTINATION') return false;

  const text = ctx.messageText.trim();
  if (text.startsWith('/')) return false;

  if (ethers.isAddress(text)) {
    executeSweep(ctx, text, null);
    return true;
  } else {
    ctx.client.sendMessage(ctx.chatId, '❌ Invalid Ethereum address. Please send a valid <code>0x...</code> address:');
    return true;
  }
}

module.exports = {
  handleSweep,
  handleSweepCallback,
  executeSweep,
  handleSweepPendingInput,
  activeSweepWizards
};
