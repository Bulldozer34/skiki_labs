const axios = require('axios');
const connectionManager = require('../../services/connectionManager');
const logger = require('../../utils/logger');

/**
 * Measure round-trip latency to a target endpoint using persistent keep-alive sockets
 * @param {string} name 
 * @param {string} url 
 * @param {string} method 
 * @param {object|null} data 
 * @param {object} headers 
 * @param {string} category 'rpc' | 'api' | 'notify'
 * @returns {Promise<{name: string, ms: number, status: string, category: string}>}
 */
async function measurePing(name, url, method = 'GET', data = null, headers = {}, category = 'api') {
  const isHttps = url.startsWith('https:');
  const agent = isHttps ? connectionManager.httpsAgent : connectionManager.httpAgent;

  const config = {
    timeout: 3500,
    httpsAgent: agent,
    httpAgent: agent,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Connection': 'keep-alive',
      ...headers
    },
    validateStatus: () => true // Treat HTTP 200-404 as valid network RTT
  };

  const t0 = Date.now();
  try {
    if (method === 'POST') {
      await axios.post(url, data || {}, config);
    } else if (method === 'HEAD') {
      await axios.head(url, config);
    } else {
      await axios.get(url, config);
    }
    const ms = Date.now() - t0;
    return { name, ms, status: 'OK', category };
  } catch (err) {
    const ms = Date.now() - t0;
    return { name, ms, status: err.code === 'ECONNABORTED' ? 'TIMEOUT' : 'ERROR', category };
  }
}

/**
 * Perform latency benchmark across all connected services
 */
async function runLatencyBenchmark() {
  const quickNodeUrl = process.env.QUICKNODE_URL;
  const rhRpc = 'https://rpc.mainnet.chain.robinhood.com';

  const targets = [
    { name: 'Robinhood Sequencer RPC', url: rhRpc, method: 'POST', data: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }, category: 'rpc' },
    ...(quickNodeUrl ? [{ name: 'QuickNode Dedicated VIP', url: quickNodeUrl, method: 'POST', data: { jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }, category: 'rpc' }] : []),
    { name: 'OpenSea GraphQL Engine', url: 'https://gql.opensea.io/graphql/', method: 'GET', category: 'api' },
    { name: 'OpenSea REST API v2', url: 'https://api.opensea.io/api/v2/collections/kenji-origins', method: 'HEAD', category: 'api' },
    { name: 'Discord Webhook Gateway', url: 'https://discord.com', method: 'HEAD', category: 'notify' },
    { name: 'Telegram Bot Gateway', url: 'https://api.telegram.org', method: 'HEAD', category: 'notify' }
  ];

  // Staggered execution to prevent CPU spike on container during TLS handshake
  const results = [];
  for (const t of targets) {
    const res = await measurePing(t.name, t.url, t.method, t.data, t.headers, t.category);
    results.push(res);
  }

  return results;
}

/**
 * Handle /latency and /ping command in Telegram
 */
async function handleLatency(ctx) {
  const { client, chatId, messageId } = ctx;

  const tempMsg = await client.sendMessage(chatId, `📡 <b>Measuring live network telemetry from VPS...</b>`, { parse_mode: 'HTML' });

  const results = await runLatencyBenchmark();
  const dateStr = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const rpcResults = results.filter(r => r.category === 'rpc');
  const apiResults = results.filter(r => r.category === 'api');
  const notifyResults = results.filter(r => r.category === 'notify');

  const formatLine = (r) => {
    let icon = '🟢';
    if (r.status !== 'OK') icon = '🔴';
    else if (r.ms > 150) icon = '🔴';
    else if (r.ms > 80) icon = '🟡';

    const msText = r.status === 'OK' ? `<code>${r.ms}ms</code>` : `<code>${r.status}</code>`;
    return `${icon} <b>${r.name}:</b> ${msText}`;
  };

  const lines = [
    `📡 <b>LIVE VPS LATENCY TELEMETRY</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📍 <b>Location:</b> Render Cloud (Ohio, US East)`,
    `⏱️ <b>Measured At:</b> ${dateStr} UTC`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<b>🚀 Mint Execution Path (Critical):</b>`,
    ...rpcResults.map(formatLine),
    ``,
    `<b>🔍 Drop & Metadata APIs:</b>`,
    ...apiResults.map(formatLine),
    ``,
    `<b>💬 Notification Gateways (Non-blocking):</b>`,
    ...notifyResults.map(formatLine),
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>🟢 Ultra-fast (&lt;80ms) | 🟡 Good (80-150ms) | 🔴 Slow (&gt;150ms)</i>`,
    `💡 <i>Telegram latency is UI only — mint transactions blast directly to the Sequencer RPC.</i>`
  ];

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
