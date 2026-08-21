const https = require('https');
const http = require('http');
const axios = require('axios');
const { ethers } = require('ethers');

/**
 * Persistent Connection Manager for high-speed socket reuse
 */
class ConnectionManager {
  constructor() {
    // 1. Configure Persistent Keep-Alive Agents
    this.httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 50,
      maxFreeSockets: 20,
      timeout: 15000,
      scheduling: 'lifo' // Last-In First-Out reuses the hottest sockets first
    });

    this.httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 60000,
      maxSockets: 50,
      maxFreeSockets: 20,
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
  }

  /**
   * Create an ethers v6 JsonRpcProvider using persistent Keep-Alive sockets
   * @param {string} rpcUrl 
   * @param {number} chainId 
   * @returns {ethers.JsonRpcProvider}
   */
  createEthersProvider(rpcUrl, chainId) {
    const fetchReq = new ethers.FetchRequest(rpcUrl);
    
    fetchReq.getUrlFunc = ethers.FetchRequest.createGetUrlFunc({
      agent: rpcUrl.startsWith('https') ? this.httpsAgent : this.httpAgent
    });

    return new ethers.JsonRpcProvider(fetchReq, chainId || undefined, { staticNetwork: true });
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
}

module.exports = new ConnectionManager();
