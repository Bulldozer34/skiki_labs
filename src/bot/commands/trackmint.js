const dropTrackerService = require('../../services/dropTrackerService');
const logger = require('../../utils/logger');

/**
 * Handle /trackmint <opensea-url-or-slug>
 */
async function handleTrackMint(ctx) {
  const { client, chatId, args, messageText } = ctx;
  const input = (args && args[0]) ? args[0].trim() : (messageText ? messageText.replace(/^\/trackmint\s*/i, '').trim() : '');

  if (!input) {
    return await client.sendMessage(
      chatId,
      [
        `🎯 <b>Track OpenSea Drop Phase Transitions</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Monitors upcoming or ongoing mints and sends automatic high-priority alerts when the drop transitions toward the Public stage (T-15m, T-5m, and T-0 LIVE).`,
        `\n<b>Usage:</b>`,
        `<code>/trackmint &lt;OpenSea URL or Slug&gt;</code>`,
        `\n<b>Example:</b>`,
        `<code>/trackmint https://opensea.io/collection/echo-rh/drop</code>`,
        `<code>/trackmint echo-rh</code>`,
        `\n<i>Send /trackedmints to view all actively monitored drops.</i>`
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }

  try {
    const statusMsg = await client.sendMessage(chatId, `🔍 Fetching drop stages & contract info from OpenSea...`, { parse_mode: 'HTML' });
    const drop = await dropTrackerService.trackDrop(input);

    const nowSec = Math.floor(Date.now() / 1000);
    let publicTimeText = 'Not Scheduled';
    if (drop.publicStartTime) {
      const diffSec = drop.publicStartTime - nowSec;
      if (diffSec <= 0) {
        publicTimeText = '🟢 NOW LIVE!';
      } else {
        const hrs = Math.floor(diffSec / 3600);
        const mins = Math.floor((diffSec % 3600) / 60);
        publicTimeText = hrs > 0 ? `In ~${hrs}h ${mins}m` : `In ~${mins} minutes`;
      }
    }

    const text = [
      `✅ <b>Now Tracking Drop:</b> <b>${drop.name}</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🎯 <b>Contract:</b> <code>${drop.contractAddress || 'Pending deployment'}</code>`,
      `🔗 <b>Chain:</b> ${drop.chain}`,
      `🎭 <b>Total Stages:</b> ${drop.stagesCount}`,
      `⏳ <b>Current Stage:</b> <code>${drop.currentStageName}</code>`,
      `🚀 <b>Public Stage:</b> <code>${publicTimeText}</code>`,
      `💰 <b>Public Price:</b> <code>${drop.publicPrice}</code>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `<i>The bot will monitor this drop and alert you at T-15m, T-5m, and when Public opens!</i>`
    ].join('\n');

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '📋 View All Tracked Mints', callback_data: 'cmd_tracked_mints' },
          { text: '❌ Untrack', callback_data: `untrack_mint_${drop.slug}` }
        ]
      ]
    };

    if (statusMsg && statusMsg.message_id) {
      return await client.editMessageText(chatId, statusMsg.message_id, text, { parse_mode: 'HTML', reply_markup });
    }
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  } catch (err) {
    logger.error(`[TrackMint] Error tracking ${input}: ${err.message}`);
    return await client.sendMessage(chatId, `❌ Failed to track drop: ${err.message}`, { parse_mode: 'HTML' });
  }
}

/**
 * Handle /trackedmints
 */
async function handleTrackedMints(ctx) {
  const { client, chatId, messageId } = ctx;
  const drops = dropTrackerService.getTrackedDrops();

  if (drops.length === 0) {
    const text = [
      `📋 <b>Active Tracked Drops (0)</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `No drops are currently being monitored for phase transitions.`,
      `\nTo track an OpenSea drop, send:`,
      `<code>/trackmint &lt;OpenSea URL&gt;</code>`
    ].join('\n');

    if (messageId) {
      return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML' }).catch(() => {});
    }
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML' });
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const lines = [
    `📋 <b>Active Tracked Drops (${drops.length})</b>`,
    `━━━━━━━━━━━━━━━━━━━━`
  ];

  const keyboard = [];

  drops.forEach((d, idx) => {
    let countdown = 'TBD';
    if (d.publicStartTime) {
      const diffSec = d.publicStartTime - nowSec;
      countdown = diffSec <= 0 ? '🟢 LIVE' : `in ~${Math.ceil(diffSec / 60)}m`;
    }
    lines.push(`• <b>#${idx + 1} ${d.name}</b>`);
    lines.push(`  Stage: <code>${d.currentStageName}</code> | Public: <code>${countdown}</code> (${d.publicPrice})`);
    lines.push(`  Contract: <code>${(d.contractAddress || d.slug).slice(0, 10)}...</code>`);

    keyboard.push([
      { text: `🎯 Snipe ${d.name.slice(0, 12)}`, callback_data: `snipe_now_${d.contractAddress || d.slug}` },
      { text: `❌ Remove`, callback_data: `untrack_mint_${d.slug}` }
    ]);
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>Alerts fire automatically as drops approach Public mint.</i>`);

  keyboard.push([{ text: '🔄 Refresh', callback_data: 'cmd_tracked_mints' }]);

  const reply_markup = { inline_keyboard: keyboard };

  if (messageId) {
    return await client.editMessageText(chatId, messageId, lines.join('\n'), { parse_mode: 'HTML', reply_markup }).catch(() => {});
  }
  return await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle /untrackmint <slug>
 */
async function handleUntrackMint(ctx) {
  const { client, chatId, args, messageText } = ctx;
  const input = (args && args[0]) ? args[0].trim() : (messageText ? messageText.replace(/^\/untrackmint\s*/i, '').trim() : '');

  if (!input) {
    return await client.sendMessage(chatId, `⚠️ Usage: <code>/untrackmint &lt;slug or OpenSea URL&gt;</code>`, { parse_mode: 'HTML' });
  }

  const removed = dropTrackerService.untrackDrop(input);
  if (removed) {
    return await client.sendMessage(chatId, `✅ Stopped tracking drop: <code>${input}</code>`, { parse_mode: 'HTML' });
  }
  return await client.sendMessage(chatId, `⚠️ Drop not found in tracked list: <code>${input}</code>`, { parse_mode: 'HTML' });
}

module.exports = {
  handleTrackMint,
  handleTrackedMints,
  handleUntrackMint
};
