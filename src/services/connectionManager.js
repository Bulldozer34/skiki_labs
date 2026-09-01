const https = require('https');
const http = require('http');
const dns = require('dns');
const { promisify } = require('util');
const dnsLookup = promisify(dns.lookup);
const axios = require('axios');
const { ethers } = require('ethers');

/**
 * Persistent Connection Manager for high-speed socket reuse
 * Supports both HTTP and WebSocket RPC connections with DNS cache and TCP_NODELAY
 */
class ConnectionManager {
  constructor() {
    // In-memory DNS cache: hostname -> IPv4
    this._dnsCache = new Map();

    const customLookup = (hostname, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }
      const cached = this._dnsCache.get(hostname);
      if (cached) {
        return callback(null, cached, 4);
      }
      dns.lookup(hostname, { family: 4 }, (err, address, family) => {
        if (!err && address) {
          this._dnsCache.set(hostname, address);
        }
        callback(err, address, family);
      });
    };

    // 1. Configure Persistent Keep-Alive Agents with TCP_NODELAY & IPv4 Fast-Path & Custom DNS
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 120000,
      maxSockets: 200,
      maxFreeSockets: 100,
      timeout: 15000,
      scheduling: 'lifo', // Last-In First-Out reuses the hottest sockets first
      noDelay: true,      // Disable Nagle algorithm (TCP_NODELAY) for instant packet dispatch
      family: 4,          // Force IPv4 to prevent 250ms+ IPv6 fallback stalls on Windows
      lookup: customLookup
    });

    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 120000,
      maxSockets: 200,
      maxFreeSockets: 100,
      timeout: 15000,
      scheduling: 'lifo',
      noDelay: true,
      family: 4,
      lookup: customLookup
    });

    // 2. Pre-configured Axios instance with persistent sockets
    this.axiosInstance = axios.create({
      httpsAgent: this.httpsAgent,
      httpAgent: this.httpAgent,
      timeout: 10000,
      headers: {
        'Connection': 'keep-alive',
        'Content-Type': 'application/json'
      }
    });

    // 3. Provider cache — reuse providers for the same RPC URL
    this._providerCache = new Map();

    // 4. WebSocket provider cache
    this._wsProviderCache = new Map();

    // 4b. URLs whose WebSocket upgrade was refused — never retried
    this._wsDeadUrls = new Set();

    // 5. Pre-serialized JSON-RPC buffer cache
    this._bufferPayloadCache = new Map();
  }

  /**
   * Create an ethers v6 JsonRpcProvider using persistent Keep-Alive sockets
   * Caches providers per URL to avoid creating duplicates
   * @param {string} rpcUrl 
   * @param {number} chainId 
   * @returns {ethers.JsonRpcProvider}
   */
  createEthersProvider(rpcUrl, chainId) {
    const cacheKey = `${rpcUrl}:${chainId || 'auto'}`;
    if (this._providerCache.has(cacheKey)) {
      return this._providerCache.get(cacheKey);
    }

    const fetchReq = new ethers.FetchRequest(rpcUrl);
    
    fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({
      agent: rpcUrl.startsWith('https') ? this.httpsAgent : this.httpAgent
    });

    const provider = new ethers.JsonRpcProvider(fetchReq, chainId || undefined, { staticNetwork: true });
    this._providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * Pre-build and cache binary JSON-RPC Buffer payload for zero-allocation broadcast
   * @param {string} signedTx 
   * @returns {Buffer}
   */
  createRawBufferPayload(signedTx) {
    if (this._bufferPayloadCache.has(signedTx)) {
      return this._bufferPayloadCache.get(signedTx);
    }
    const jsonStr = JSON.stringify({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: 'eth_sendRawTransaction',
      params: [signedTx]
    });
    const buf = Buffer.from(jsonStr, 'utf-8');
    this._bufferPayloadCache.set(signedTx, buf);
    return buf;
  }

  /**
   * Send pre-serialized Buffer directly over HTTP keep-alive socket (0 JSON.stringify overhead)
   * @param {string} rpcUrl 
   * @param {Buffer} bufferPayload 
   * @param {number} [timeoutMs=8000] 
   * @returns {Promise<string>}
   */
  async sendRawTransactionBuffer(rpcUrl, bufferPayload, timeoutMs = 8000) {
    const res = await this.axiosInstance.post(rpcUrl, bufferPayload, {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': bufferPayload.length
      },
      timeout: timeoutMs
    });

    if (res.data && res.data.result) {
      return res.data.result;
    }

    if (res.data && res.data.error) {
      const err = new Error(res.data.error.message || JSON.stringify(res.data.error));
      err.code = res.data.error.code;
      err.data = res.data.error.data;
      throw err;
    }

    throw new Error(`Invalid JSON-RPC response from ${rpcUrl}`);
  }

  /**
   * High-speed direct raw JSON-RPC eth_sendRawTransaction broadcast over keep-alive socket
   * Bypasses ethers abstraction layer to achieve < 50ms broadcast latency
   * @param {string} rpcUrl 
   * @param {string} signedTx 
   * @param {number} [timeoutMs=8000] 
   * @returns {Promise<string>} Transaction hash
   */
  async sendRawTransactionRaw(rpcUrl, signedTx, timeoutMs = 8000) {
    const buf = this.createRawBufferPayload(signedTx);
    return await this.sendRawTransactionBuffer(rpcUrl, buf, timeoutMs);
  }

  /**
   * Ultra-fast raw JSON-RPC receipt query bypassing ethers wrapper
   * @param {string} rpcUrl 
   * @param {string} txHash 
   * @param {number} [timeoutMs=3000] 
   * @returns {Promise<object|null>}
   */
  async getRawReceipt(rpcUrl, txHash, timeoutMs = 3000) {
    try {
      const res = await this.axiosInstance.post(rpcUrl, {
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1000000),
        method: 'eth_getTransactionReceipt',
        params: [txHash]
      }, {
        timeout: timeoutMs
      });

      if (res.data && res.data.result) {
        return res.data.result;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Create a WebSocket provider for push-based receipt listening
   * Returns null (caller falls back to HTTP) if the URL is unusable or already known dead
   * @param {string} wsUrl WebSocket RPC URL (wss://... or ws://...)
   * @param {number} chainId
   * @returns {ethers.WebSocketProvider|null}
   */
  createWsProvider(wsUrl, chainId) {
    if (!wsUrl || !/^wss?:\/\//.test(wsUrl)) {
      return null;
    }

    const cacheKey = `ws:${wsUrl}:${chainId || 'auto'}`;
    if (this._wsProviderCache.has(cacheKey)) {
      return this._wsProviderCache.get(cacheKey);
    }
    if (this._wsDeadUrls.has(cacheKey)) {
      return null;
    }

    try {
      const provider = new ethers.WebSocketProvider(wsUrl, chainId || undefined);

      // ethers v6 assigns onopen/onmessage but never an error handler. The `ws`
      // socket underneath is an EventEmitter, so a refused upgrade — the normal
      // answer from Cloudflare-fronted L2 RPCs like Robinhood — raises an
      // unhandled 'error' event and terminates the process mid-snipe.
      const socket = provider.websocket;
      if (socket) {
        const onError = () => {
          this._wsDeadUrls.add(cacheKey);
          this._wsProviderCache.delete(cacheKey);
          try { provider.destroy(); } catch (e) {}
        };
        // Drop the cached provider on close so a later call reconnects instead
        // of handing out a dead socket, but don't blacklist the URL — a healthy
        // endpoint can still disconnect transiently.
        const onClose = () => { this._wsProviderCache.delete(cacheKey); };

        if (typeof socket.on === 'function') {
          socket.on('error', onError);
          socket.on('close', onClose);
        } else {
          socket.onerror = onError;
          socket.onclose = onClose;
        }
      }

      this._wsProviderCache.set(cacheKey, provider);
      return provider;
    } catch (err) {
      this._wsDeadUrls.add(cacheKey);
      return null;
    }
  }

  /**
   * Confirm a WebSocket provider actually reached OPEN and answers RPC calls.
   * An unverified provider must never be used for broadcasting — a socket stuck
   * in CONNECTING swallows the request and costs the whole drop.
   * @param {ethers.WebSocketProvider|null} provider
   * @param {number} [timeoutMs=2500]
   * @returns {Promise<boolean>}
   */
  async verifyWsProvider(provider, timeoutMs = 2500) {
    if (!provider) return false;
    let timer = null;
    try {
      await Promise.race([
        provider.getBlockNumber(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WebSocket verification timeout')), timeoutMs);
        })
      ]);
      return true;
    } catch (err) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Resolve the first WebSocket provider that is verifiably live for a set of RPC URLs.
   * @param {string[]} rpcUrls
   * @param {number} chainId
   * @param {number} [timeoutMs=2500]
   * @returns {Promise<{ provider: ethers.WebSocketProvider, url: string }|null>}
   */
  async resolveLiveWsProvider(rpcUrls, chainId, timeoutMs = 2500) {
    for (const wsUrl of ConnectionManager.collectWsCandidates(rpcUrls)) {
      const provider = this.createWsProvider(wsUrl, chainId);
      if (!provider) continue;
      if (await this.verifyWsProvider(provider, timeoutMs)) {
        return { provider, url: wsUrl };
      }
      // Verification failed: stop offering this URL for the rest of the session
      this._wsDeadUrls.add(`ws:${wsUrl}:${chainId || 'auto'}`);
      this._wsProviderCache.delete(`ws:${wsUrl}:${chainId || 'auto'}`);
      try { provider.destroy(); } catch (e) {}
    }
    return null;
  }

  /**
   * Build the ordered list of WebSocket URLs worth trying for a set of HTTP RPC URLs.
   * An explicit RPC_WS_URL always goes first — it is the only way to get a WebSocket
   * on a chain whose public endpoint is HTTP-only.
   * @param {string[]} rpcUrls
   * @returns {string[]}
   */
  static collectWsCandidates(rpcUrls) {
    const candidates = [];

    const override = (process.env.RPC_WS_URL || process.env.WS_RPC_URL || '').trim();
    if (override && /^wss?:\/\//.test(override)) {
      candidates.push(override);
    }

    for (const url of (rpcUrls || []).filter(Boolean)) {
      const wsUrl = ConnectionManager.httpToWs(url);
      if (wsUrl) candidates.push(wsUrl);
    }

    return Array.from(new Set(candidates));
  }

  /**
   * Convert an HTTP RPC URL to its WebSocket equivalent.
   *
   * Only providers known to serve JSON-RPC over WebSocket on the same host are
   * mapped. Probed 2026-08-31 with an HTTP/1.1 upgrade handshake: PublicNode
   * answers 101, while the Robinhood mainnet/testnet RPCs (400), Base (405),
   * Arbitrum (400/404) and Optimism (405) public endpoints all refuse it. So a
   * blanket https->wss rewrite yields a socket that never opens on exactly the
   * chains this bot targets — set RPC_WS_URL (e.g. an Alchemy `robinhood-mainnet`
   * endpoint) to give those chains a real WebSocket, or RPC_WS_GUESS=1 to opt
   * into the rewrite for an endpoint you have verified yourself.
   *
   * @param {string} httpUrl
   * @returns {string|null}
   */
  static httpToWs(httpUrl) {
    if (!httpUrl) return null;

    const url = String(httpUrl).trim();
    if (url.startsWith('wss://') || url.startsWith('ws://')) return url;
    if (!/^https?:\/\//.test(url)) return null;

    const asWs = () => url.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://');

    // Infura exposes WebSocket under a different path segment
    if (url.includes('infura.io')) {
      return asWs().replace('/v3/', '/ws/v3/');
    }

    if (ConnectionManager.WS_SAME_HOST_PROVIDERS.some(host => url.includes(host))) {
      return asWs();
    }

    const guess = (process.env.RPC_WS_GUESS || '').trim().toLowerCase();
    if (guess === '1' || guess === 'true' || guess === 'yes') {
      return asWs();
    }

    return null;
  }

  /**
   * Get the fastest available provider for an RPC URL.
   * Only hands back a WebSocket that is already cached and live — a fresh socket
   * has not finished its handshake yet, so HTTP is the correct synchronous answer.
   * Use resolveLiveWsProvider() when you can await verification.
   * @param {string} rpcUrl
   * @param {number} chainId
   * @returns {{ provider: ethers.Provider, type: string }}
   */
  getFastestProvider(rpcUrl, chainId) {
    const wsUrl = ConnectionManager.httpToWs(rpcUrl);
    if (wsUrl) {
      const cacheKey = `ws:${wsUrl}:${chainId || 'auto'}`;
      const cached = this._wsProviderCache.get(cacheKey);
      if (cached && cached.websocket && cached.websocket.readyState === 1) {
        return { provider: cached, type: 'websocket' };
      }
    }
    return { provider: this.createEthersProvider(rpcUrl, chainId), type: 'http' };
  }

  /**
   * Pre-warm connections against OpenSea API & RPC endpoints immediately
   * Pre-establishes TCP + TLS connections so first broadcast has 0ms connection latency
   * @param {string[]} endpoints 
   */
  async preWarmSockets(endpoints) {
    const warmPromises = endpoints.filter(Boolean).map(async (url) => {
      try {
        if (url.includes('opensea.io')) {
          await this.axiosInstance.head(url).catch(() => {});
        } else {
          await this.axiosInstance.post(url, {
            jsonrpc: '2.0',
            id: 1,
            method: 'eth_blockNumber',
            params: []
          }).catch(() => {});
        }
      } catch (err) {
        // Warmup errors are non-critical
      }
    });

    await Promise.allSettled(warmPromises);
  }

  /**
   * Measure the round-trip time to an endpoint over the already-warm socket pool.
   *
   * This exists because the sniper's lead time is a guess about network flight
   * time, and a guess is the wrong tool: on a FIFO chain the transaction must
   * arrive at the sequencer as soon as possible *after* the drop opens, so the
   * trigger has to fire one one-way flight early. That distance is ~120ms from a
   * home connection and ~2ms from an EC2 host in the sequencer's own region, so
   * any hardcoded constant is badly wrong in one of those two places.
   *
   * Errors count as samples. A broadcast-only sequencer ingress rejects
   * `eth_blockNumber`, but the rejection travels the same path as a transaction
   * would, so its timing is exactly what we want to know. Only transport-level
   * failures (no response at all) are discarded.
   *
   * @param {string} url
   * @param {number} [samples=5]
   * @returns {Promise<number|null>} Median round-trip in ms, or null if unreachable
   */
  async measureRoundTripMs(url, samples = 5) {
    if (!url) return null;
    const timings = [];

    for (let i = 0; i < samples; i++) {
      const startedAt = process.hrtime.bigint();
      try {
        await this.axiosInstance.post(url, {
          jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: []
        });
        timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
      } catch (err) {
        // A JSON-RPC error still means bytes made the round trip; a transport
        // failure (DNS, refused, timeout) does not and must not be timed.
        if (err && err.response) {
          timings.push(Number(process.hrtime.bigint() - startedAt) / 1e6);
        }
      }
    }

    if (!timings.length) return null;
    timings.sort((a, b) => a - b);
    return timings[Math.floor(timings.length / 2)];
  }

  /**
   * Pre-resolve all hostnames to IPv4 addresses into memory cache
   * Completely eliminates 40-80ms DNS resolution stalls during drop time
   * @param {string[]} urls
   */
  async preResolveDns(urls) {
    const promises = (urls || []).filter(Boolean).map(async (u) => {
      try {
        const parsed = new URL(u);
        const res = await dnsLookup(parsed.hostname, { family: 4 });
        if (res && res.address) {
          this._dnsCache.set(parsed.hostname, res.address);
        }
      } catch (e) {}
    });
    await Promise.allSettled(promises);
  }

  /**
   * Destroy all cached WebSocket connections on shutdown
   */
  async destroyWsConnections() {
    for (const [, provider] of this._wsProviderCache) {
      try { await provider.destroy(); } catch (e) {}
    }
    this._wsProviderCache.clear();
  }
}

/**
 * Providers verified to serve JSON-RPC over WebSocket on the same host and path,
 * so a plain https:// -> wss:// rewrite is safe. Deliberately short: an entry
 * that does not really speak WebSocket produces a socket stuck in CONNECTING,
 * which is worse than having no WebSocket at all.
 */
ConnectionManager.WS_SAME_HOST_PROVIDERS = [
  'alchemy.com',    // wss on the same /v2/<key> path
  'publicnode.com', // probed 2026-08-31: HTTP upgrade -> 101
  'quiknode.pro'    // issues paired https/wss on one host
];

module.exports = new ConnectionManager();


