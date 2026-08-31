const { ethers } = require('ethers');
const logger = require('../utils/logger');
const connectionManager = require('../services/connectionManager');

/**
 * Multi-RPC Simultaneous Broadcast Engine (Races multiple free RPC providers)
 * v3.1 — Lower poll interval, WebSocket receipt listening, provider caching
 */
class MultiRpcBroadcaster {
  /**
   * @param {string[]} rpcUrls Array of unique RPC endpoints
   * @param {number} chainId
   */
  constructor(rpcUrls, chainId) {
    // Filter duplicates and empty values
    this.rpcUrls = Array.from(new Set(rpcUrls.filter(Boolean)));
    this.chainId = chainId;
    // Use cached providers from connectionManager instead of creating new ones each time
    this.providers = this.rpcUrls.map(url => connectionManager.createEthersProvider(url, chainId));

    // Try to get a WebSocket provider for push-based receipt listening
    this.wsProvider = null;
    for (const url of this.rpcUrls) {
      const wsUrl = connectionManager.constructor.httpToWs(url);
      if (wsUrl) {
        this.wsProvider = connectionManager.createWsProvider(wsUrl, chainId);
        if (this.wsProvider) break;
      }
    }
  }

  /**
   * Detect RPC error messages that actually indicate successful mempool propagation
   * @param {string} msg 
   */
  static isBenignDuplicateError(msg) {
    if (!msg) return false;
    const benignPatterns = [
      /already known/i,
      /known transaction/i,
      /transaction already in mempool/i,
      /nonce too low/i,
      /already imported/i,
      /replacement transaction underpriced/i,
      /tx already exists/i
    ];
    return benignPatterns.some(p => p.test(msg));
  }

  /**
   * Concurrently broadcast a raw signed transaction across all configured RPCs
   * Uses high-speed raw JSON-RPC over pre-warmed sockets with fallback to ethers provider
   * @param {string} signedTx Pre-signed raw transaction bytes (0x...)
   * @returns {Promise<{ txHash: string, fastestRpc: string, durationMs: number }>}
   */
  async broadcastFastest(signedTx) {
    const startTime = Date.now();
    const computedTxHash = ethers.keccak256(signedTx);

    const broadcastPromises = this.rpcUrls.map(async (url, index) => {
      const provider = this.providers[index];
      try {
        // Fast path: Direct raw JSON-RPC over persistent TCP_NODELAY socket
        let txHash;
        try {
          txHash = await connectionManager.sendRawTransactionRaw(url, signedTx, 6000);
        } catch (rawErr) {
          if (MultiRpcBroadcaster.isBenignDuplicateError(rawErr.message)) {
            return { url, txHash: computedTxHash, status: 'ALREADY_PROPAGATED' };
          }
          // Fallback path: standard ethers provider broadcast
          const txResponse = await provider.broadcastTransaction(signedTx);
          txHash = txResponse.hash;
        }

        return {
          url,
          txHash: txHash || computedTxHash,
          status: 'ACCEPTED'
        };
      } catch (err) {
        if (MultiRpcBroadcaster.isBenignDuplicateError(err.message)) {
          return {
            url,
            txHash: computedTxHash,
            status: 'ALREADY_PROPAGATED'
          };
        }
        throw new Error(`[${url}] ${err.message}`);
      }
    });

    // 1. Race for the first node that acknowledges or accepts the transaction
    const fastestResult = await Promise.any(broadcastPromises);
    const durationMs = Date.now() - startTime;

    return {
      txHash: fastestResult.txHash || computedTxHash,
      fastestRpc: fastestResult.url,
      durationMs
    };
  }

  /**
   * FIFO Sequencer Packet Flood:
   * Concurrently blasts raw pre-signed transaction across all RPC endpoints at micro-interval offsets.
   * Because the nonce is fixed, duplicates cost 0 extra gas while saturating the top of the sequencer queue.
   * @param {string} signedTx 
   * @param {number[]} [burstOffsets=[0, 60, 150, 280]] Millisecond burst offsets
   * @returns {Promise<{ txHash: string, fastestRpc: string, durationMs: number }>}
   */
  async broadcastFlood(signedTx, burstOffsets = [0, 60, 150, 280]) {
    const startTime = Date.now();
    const computedTxHash = ethers.keccak256(signedTx);

    // Launch burst storm across all endpoints
    const allBursts = burstOffsets.map(async (offset) => {
      if (offset > 0) {
        await new Promise(r => setTimeout(r, offset));
      }
      return await this.broadcastFastest(signedTx).catch(() => ({
        txHash: computedTxHash,
        fastestRpc: this.rpcUrls[0] || 'sequencer',
        durationMs: Date.now() - startTime
      }));
    });

    const fastestResult = await Promise.any(allBursts);
    return {
      txHash: fastestResult.txHash || computedTxHash,
      fastestRpc: fastestResult.fastestRpc,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Race multiple providers to get transaction receipt confirmation with minimum latency
   * Uses WebSocket push-based listening when available, with 40ms HTTP polling as fallback
   * @param {string} txHash 
   * @param {number} confirmations 
   * @param {number} timeoutMs 
   * @returns {Promise<{ receipt: ethers.TransactionReceipt, fastProvider: string }>}
   */
  async waitForReceiptFastest(txHash, confirmations = 1, timeoutMs = 60000) {
    const pollInterval = 40; // Ultra-fast 40ms interval for near-instant block pickup
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Strategy 1: WebSocket-based receipt listening (fastest — push-based, no polling)
      if (this.wsProvider) {
        this.wsProvider.waitForTransaction(txHash, confirmations, timeoutMs)
          .then(receipt => {
            if (!resolved && receipt) {
              resolved = true;
              resolve({ receipt, fastProvider: 'websocket' });
            }
          })
          .catch(() => {}); // WS errors are non-fatal; HTTP polling continues
      }

      // Strategy 2: High-frequency HTTP polling across all providers (fallback / parallel race)
      const checkReceipt = async (provider, url) => {
        while (!resolved && Date.now() < deadline) {
          try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber) {
              const confirms = await receipt.confirmations();
              if (confirms >= confirmations && !resolved) {
                resolved = true;
                resolve({ receipt, fastProvider: url });
                return;
              }
            }
          } catch (e) {
            // Ignore polling errors on individual endpoints
          }
          await new Promise(r => setTimeout(r, pollInterval));
        }
      };

      // Poll across all providers simultaneously
      this.providers.forEach((p, idx) => checkReceipt(p, this.rpcUrls[idx]));

      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Transaction confirmation timeout after ${timeoutMs / 1000}s for ${txHash}`));
        }
      }, timeoutMs);
    });
  }
}

module.exports = MultiRpcBroadcaster;

