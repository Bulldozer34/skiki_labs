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
    // 1. Configure Persistent Keep-Alive Agents
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 100,       // Increased from 50
      maxFreeSockets: 40,    // Increased from 20
      timeout: 15000,
      scheduling: 'lifo' // Last-In First-Out reuses the hottest sockets first
    });

    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 100,
      maxFreeSockets: 40,
      timeout: 15000,
      scheduling: 'lifo'
    });

    // 2. Pre-configured Axios instance with persistent sockets
    this.axiosInstance = axios.create({
      httpsAgent: this.httpsAgent,
      httpAgent: this.httpAgent,
      timeout: 10000,
      headers: {
        'Connection': 'keep-alive'
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
   * Pre-warm connections against GraphQL & RPC endpoints at T-5s
   * @param {string[]} endpoints 
   */
  async preWarmSockets(endpoints) {
    const warmPromises = endpoints.filter(Boolean).map(async (url) => {
      try {
        if (url.includes('graphql')) {
          await this.axiosInstance.head(url).catch(() => {});
        } else {
          await this.axiosInstance.post(url, {
            jsonrpc: '2.0',
            id: 1,
            method: 'net_version',
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

