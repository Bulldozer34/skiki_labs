const axios = require('axios');
const logger = require('../../utils/logger');

async function measurePing(name, url, method = 'GET', data = null, headers = {}) {
  const t0 = Date.now();
  try {
    const config = {
      timeout: 3000,
      headers: { 'User-Agent': 'Mozilla/5.0', ...headers },
      validateStatus: () => true // Treat 200, 400, 404 as valid network response
    };
    if (method === 'POST') {
      await axios.post(url, data || {}, config);
    } else {
      await axios.get(url, config);
    }
    const ms = Date.now() - t0;
    return { name, ms, status: 'OK' };
  } catch (err) {
    const ms = Date.now() - t0;
    return { name, ms, status: err.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR' };
  }
}

/**
 * Perform latency benchmark across all connected services
 */
async function runLatencyBenchmark() {
  const quickNodeUrl = process.env.QUICKNODE_URL;
  const rhRpc = 'https://rpc.mainnet.chain.robinhood.com';

  const targets = [
    { name: 'Robinhood Sequencer RPC', url: rhRpc, method: 'POST', data: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 } },
    ...(quickNodeUrl ? [{ name: 'QuickNode Dedicated VIP', url: quickNodeUrl, method: 'POST', data: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 } }] : []),
    { name: 'OpenSea GraphQL Engine', url: 'https://gql.opensea.io/graphql/', method: 'GET' },
    { name: 'OpenSea REST API v2', url: 'https://api.opensea.io/api/v2/collections', method: 'GET' },
    { name: 'Telegram Bot Gateway', url: 'https://api.telegram.org', method: 'GET' },
    { name: 'Discord Webhook Gateway', url: 'https://discord.com', method: 'GET' }
  ];

  const results = await Promise.all(
    targets.map(t => measurePing(t.name, t.url, t.method, t.data, t.headers))
  );

  return results;
}

/**
 * Handle /latency and /ping command in Telegram
 */
async function handleLatency(ctx) {
  const { client, chatId, messageId } = ctx;

  const tempMsg = await client.sendMessage(chatId, `📡 <b>Pinging all connected endpoints from VPS...</b>`, { parse_mode: 'HTML' });

  const results = await runLatencyBenchmark();
  const dateStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const lines = [
    `📡 <b>LIVE VPS LATENCY TELEMETRY</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📍 <b>Location:</b> Render Cloud (Ohio, US East)`,
    `⏱️ <b>Measured At:</b> ${dateStr} UTC`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<b>Endpoint Round-Trip Latency:</b>`
  ];

  results.forEach(r => {
    let icon = '🟢';
    if (r.status !== 'OK') icon = '🔴';
    else if (r.ms > 150) icon = '🔴';
    else if (r.ms > 60) icon = '🟡';

    const msText = r.status === 'OK' ? `<code>${r.ms}ms</code>` : `<code>${r.status}</code>`;
    lines.push(`${icon} <b>${r.name}:</b> ${msText}`);
  });

  lines.push(`━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`<i>🟢 Ultra-fast (&lt;60ms) | 🟡 Good (60-150ms) | 🔴 Slow (&gt;150ms)</i>`);

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🔄 Re-test Ping', callback_data: 'cmd_ping_refresh' },
        { text: '⛽ Check Gas', callback_data: 'cmd_gas_refresh' }
      ],
      [
        { text: '◀️ Back to Dashboard', callback_data: 'menu_back' }
      ]
    ]
  };

  if (tempMsg && tempMsg.message_id) {
    return await client.editMessageText(chatId, tempMsg.message_id, lines.join('\n'), { parse_mode: 'HTML', reply_markup });
  }
  return await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML', reply_markup });
}

module.exports = {
  handleLatency,
  runLatencyBenchmark
};
