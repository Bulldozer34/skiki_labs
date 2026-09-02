const { CHAINS } = require('./chains');

/**
 * RPC endpoint pool.
 *
 * Lifted out of `cli.js` so the CLI, the engines and (later) the Telegram daemon
 * all build the same pool, and extended with the distinction that matters on a
 * FIFO chain: **which endpoint can actually order a transaction.**
 *
 * On Ethereum mainnet, broadcasting to many nodes is genuinely useful — gossip
 * plus a priority-gas auction decide inclusion, so more entry points means
 * faster propagation. On an Arbitrum Nitro chain like Robinhood it is close to
 * self-defeating: a single sequencer decides order first-come-first-served, and
 * every other endpoint is a replica that *forwards* to it. Each intermediary is
 * added latency, not redundancy.
 *
 * So the pool is ordered and tagged:
 *
 *   - the sequencer's write ingress first, marked `broadcastOnly` because it
 *     serves `eth_sendRawTransaction` and nothing else;
 *   - then full-service read replicas, which are what nonce/balance/receipt/
 *     simulation calls must use.
 *
 * A `broadcastOnly` endpoint must never be handed to code that reads state — it
 * answers every other method with "does not exist/is not available".
 */

/**
 * @typedef {Object} RpcEndpoint
 * @property {string} url
 * @property {boolean} broadcastOnly True when only eth_sendRawTransaction works
 * @property {string} label Short name for logs
 */

function isDisabled(value) {
  return ['0', 'false', 'no', 'off'].includes(String(value || '').trim().toLowerCase());
}

/**
 * Short, key-free label for an endpoint.
 * @param {string} url
 * @returns {string}
 */
function labelFor(url) {
  try {
    return new URL(url).hostname;
  } catch (err) {
    return String(url).slice(0, 40);
  }
}

/**
 * Build the ordered endpoint pool for a chain.
 *
 * @param {object} chainConfig Entry from CHAINS
 * @param {string} [rpcUrl] The primary RPC the user configured (Alchemy or default)
 * @returns {{endpoints: RpcEndpoint[], urls: string[], readUrls: string[], broadcastUrls: string[], sequencerUrl: string|null, feedUrl: string|null}}
 */
function buildEndpoints(chainConfig = {}, rpcUrl = null, options = {}) {
  /** @type {RpcEndpoint[]} */
  const endpoints = [];
  const seen = new Set();
  const enableQuickNode = options.enableQuickNode !== undefined
    ? options.enableQuickNode
    : (process.env.USE_QUICKNODE_ONLY_FOR_VITAL_MINTS !== 'true');

  const add = (url, { broadcastOnly = false, label = null } = {}) => {
    if (!url) return;
    const clean = String(url).trim();
    if (!clean || seen.has(clean)) return;
    seen.add(clean);
    endpoints.push({ url: clean, broadcastOnly, label: label || labelFor(clean) });
  };

  // 1. Sequencer write ingress. First because it is the only endpoint that can
  //    order a transaction; everything else forwards here anyway.
  const sequencerOverride = (process.env.SNIPER_SEQUENCER_URL || '').trim();
  const sequencerUrl = sequencerOverride || chainConfig.sequencerRpc || null;
  if (sequencerUrl && !isDisabled(process.env.SNIPER_USE_SEQUENCER)) {
    add(sequencerUrl, { broadcastOnly: true, label: 'sequencer' });
  }

  // 2. Full-service endpoints: the user's choice, then the chain default.
  add(rpcUrl);
  add(chainConfig.defaultRpc);

  // 3. Operator-supplied extras (QuickNode can be reserved for vital mints)
  if (enableQuickNode) {
    add(process.env.QUICKNODE_URL, { label: 'quicknode-vip' });
  }
  add(process.env.SECONDARY_RPC_URL);

  // 4. Ethereum mainnet keeps its extra public fallbacks — there, unlike on a
  //    single-sequencer L2, extra broadcast targets genuinely help propagation.
  if (Number(chainConfig.chainId) === 1) {
    if (process.env.ANKR_KEY) {
      add(`https://rpc.ankr.com/eth/${String(process.env.ANKR_KEY).trim()}`);
    }
    add('https://eth.llamarpc.com');
  }

  const feedOverride = (process.env.SNIPER_FEED_URL || '').trim();
  const feedUrl = isDisabled(process.env.SNIPER_USE_FEED)
    ? null
    : (feedOverride || chainConfig.feedUrl || null);

  return {
    endpoints,
    urls: endpoints.map(e => e.url),
    readUrls: endpoints.filter(e => !e.broadcastOnly).map(e => e.url),
    broadcastUrls: endpoints.map(e => e.url),
    sequencerUrl: endpoints.some(e => e.broadcastOnly) ? sequencerUrl : null,
    feedUrl
  };
}

/**
 * Backwards-compatible flat URL list.
 * @param {object} chainConfig
 * @param {string} [rpcUrl]
 * @returns {string[]}
 */
function buildRpcUrls(chainConfig, rpcUrl) {
  return buildEndpoints(chainConfig, rpcUrl).urls;
}

/**
 * A URL safe for state reads, i.e. never the broadcast-only sequencer ingress.
 * @param {object} chainConfig
 * @param {string} [rpcUrl]
 * @returns {string|null}
 */
function resolveReadUrl(chainConfig, rpcUrl) {
  const { readUrls } = buildEndpoints(chainConfig, rpcUrl);
  return readUrls[0] || null;
}

module.exports = {
  buildEndpoints,
  buildRpcUrls,
  resolveReadUrl,
  labelFor,
  CHAINS
};
