const path = require('path');
const WalletService = require('../../services/walletService');

/**
 * Handle /generate command (e.g. `/generate 5` or `/generate`).
 * @param {object} ctx
 * @param {string[]} ctx.args
 */
async function handleGenerate(ctx) {
  const { client, chatId, args, state } = ctx;

  let count = 5;
  if (args && args.length > 0) {
    const parsed = parseInt(args[0], 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 50) {
      count = parsed;
    }
  }

  const statusMsg = await client.sendMessage(
    chatId,
    `⏳ <i>Generating ${count} cryptographically secure burner wallet(s)...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const { wallets, entries } = WalletService.generateWallets(count);
    const savedPath = WalletService.saveWalletsToFile(entries);
    const fileName = path.basename(savedPath);

    // Persist new keys into master wallets.txt
    const masterPath = path.resolve(process.cwd(), 'wallets.txt');
    const newKeys = entries.map(e => e.privateKey).join('\n') + '\n';
    fs.appendFileSync(masterPath, newKeys, 'utf-8');

    // Add new wallets to the live session without losing existing wallets
    state.wallets = [...(state.wallets || []), ...wallets];

    const lines = [
      `<b>✨ Generated ${count} Fresh Burner Wallet(s)</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💾 <b>Saved to Master:</b> <code>wallets.txt</code> (backup: <code>${fileName}</code>)`,
      `💼 <b>Total Active in Session:</b> ${state.wallets.length}`,
      ``,
      `<b>📋 Public Addresses:</b>`
    ];

    entries.forEach((e) => {
      lines.push(`• <code>${e.address}</code>`);
    });

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`<i>Private keys are safely saved on the host disk. What would you like to do next?</i>`);

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '💸 Fund with 0.005 ETH', callback_data: `fund_batch:0.005` },
          { text: '💸 Fund with 0.01 ETH', callback_data: `fund_batch:0.01` }
        ],
        [
          { text: '💰 Check Balances', callback_data: 'cmd_balance' },
          { text: '🎯 Arm a Drop (/snipe)', callback_data: 'cmd_snipe' }
        ]
      ]
    };

    if (statusMsg?.message_id) {
      await client.editMessageText(chatId, statusMsg.message_id, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup
      });
    } else {
      await client.sendMessage(chatId, lines.join('\n'), {
        parse_mode: 'HTML',
        reply_markup
      });
    }
  } catch (err) {
    await client.sendMessage(chatId, `❌ Failed to generate wallets: ${err.message}`);
  }
}

module.exports = { handleGenerate };
