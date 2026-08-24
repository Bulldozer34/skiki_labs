const https = require('https');
const http = require('http');
const axios = require('axios');
const { ethers } = require('ethers');

/**
 * Persistent Connection Manager for high-speed socket reuse
 * Supports both HTTP and WebSocket RPC connections
 */
class ConnectionManager {
  constructor() {
    // 1. Configure Persistent Keep-Alive Agents with TCP_NODELAY & IPv4 Fast-Path
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 120000,
      maxSockets: 200,
      maxFreeSockets: 100,
      timeout: 15000,
      scheduling: 'lifo', // Last-In First-Out reuses the hottest sockets first
      noDelay: true,      // Disable Nagle algorithm (TCP_NODELAY) for instant packet dispatch
      family: 4           // Force IPv4 to prevent 250ms+ IPv6 fallback stalls on Windows
    });

    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 120000,
      maxSockets: 200,
      maxFreeSockets: 100,
      timeout: 15000,
      scheduling: 'lifo',
      noDelay: true,
      family: 4
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
   * High-speed direct raw JSON-RPC eth_sendRawTransaction broadcast over keep-alive socket
   * Bypasses ethers abstraction layer to achieve < 50ms broadcast latency
   * @param {string} rpcUrl 
   * @param {string} signedTx 
   * @param {number} [timeoutMs=8000] 
   * @returns {Promise<string>} Transaction hash
   */
  async sendRawTransactionRaw(rpcUrl, signedTx, timeoutMs = 8000) {
    const res = await this.axiosInstance.post(rpcUrl, {
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1000000),
      method: 'eth_sendRawTransaction',
      params: [signedTx]
    }, {
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
   * Falls back to HTTP provider if WebSocket connection fails
   * @param {string} wsUrl WebSocket RPC URL (wss://...)
   * @param {number} chainId 
   * @returns {ethers.WebSocketProvider|ethers.JsonRpcProvider}
   */
  createWsProvider(wsUrl, chainId) {
    if (!wsUrl || !wsUrl.startsWith('wss://')) {
      return null;
    }

    const cacheKey = `ws:${wsUrl}:${chainId || 'auto'}`;
    if (this._wsProviderCache.has(cacheKey)) {
      return this._wsProviderCache.get(cacheKey);
    }

    try {
      const provider = new ethers.WebSocketProvider(wsUrl, chainId || undefined);
      this._wsProviderCache.set(cacheKey, provider);
      return provider;
    } catch (err) {
      // WS not available — caller should fall back to HTTP
      return null;
    }
  }

  /**
   * Convert an HTTP RPC URL to WebSocket URL (best effort)
   * @param {string} httpUrl 
   * @returns {string|null}
   */
  static httpToWs(httpUrl) {
    if (!httpUrl) return null;
    if (httpUrl.startsWith('wss://')) return httpUrl;
    if (httpUrl.startsWith('ws://')) return httpUrl;
    // Alchemy, Infura, and most providers support wss:// on the same path
    if (httpUrl.includes('alchemy.com')) {
      return httpUrl.replace('https://', 'wss://');
    }
    if (httpUrl.includes('infura.io')) {
      return httpUrl.replace('https://', 'wss://').replace('/v3/', '/ws/v3/');
    }
    // Generic: try replacing https:// with wss://
    return null; // Don't guess for unknown providers
  }

  /**
   * Get the fastest available provider for an RPC URL
   * Prefers WebSocket if available, falls back to HTTP
   * @param {string} rpcUrl 
   * @param {number} chainId 
   * @returns {{ provider: ethers.Provider, type: string }}
   */
  getFastestProvider(rpcUrl, chainId) {
    const wsUrl = ConnectionManager.httpToWs(rpcUrl);
    if (wsUrl) {
      const wsProvider = this.createWsProvider(wsUrl, chainId);
      if (wsProvider) {
        return { provider: wsProvider, type: 'websocket' };
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
   * Destroy all cached WebSocket connections on shutdown
   */
  async destroyWsConnections() {
    for (const [, provider] of this._wsProviderCache) {
      try { await provider.destroy(); } catch (e) {}
    }
    this._wsProviderCache.clear();
  }
}

module.exports = new ConnectionManager();

