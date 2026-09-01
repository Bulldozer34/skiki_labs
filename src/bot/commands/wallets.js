/**
 * Handle /wallets command.
 * @param {object} ctx
 */
async function handleWallets(ctx) {
  const { client, chatId, state } = ctx;

  const wallets = state.wallets || [];
  if (wallets.length === 0) {
    const text = [
      `<b>💼 Loaded Wallets (0)</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `⚠️ No wallets currently loaded in the daemon session.`,
      ``,
      `<i>Use <code>/generate 5</code> to create fresh burner wallets, or configure a wallet file.</i>`
    ].join('\n');
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  const lines = [
    `<b>💼 Loaded Session Wallets (${wallets.length})</b>`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  wallets.forEach((w, idx) => {
    const addr = w.address;
    const masked = `${addr.slice(0, 8)}...${addr.slice(-6)}`;
    lines.push(`<b>#${idx + 1}:</b> <code>${masked}</code>`);
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Send /balance to check live funds, or /generate to create more.</i>`);

  await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
}

module.exports = { handleWallets };
