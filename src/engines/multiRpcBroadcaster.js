const { ethers } = require('ethers');
const logger = require('../utils/logger');
const connectionManager = require('../services/connectionManager');

/**
 * Multi-RPC Simultaneous Broadcast Engine (Races multiple free RPC providers)
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
    this.providers = this.rpcUrls.map(url => connectionManager.createEthersProvider(url, chainId));
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
   * @param {string} signedTx Pre-signed raw transaction bytes (0x...)
   * @returns {Promise<{ txHash: string, fastestRpc: string, durationMs: number }>}
   */
  async broadcastFastest(signedTx) {
    const startTime = Date.now();
    const computedTxHash = ethers.keccak256(signedTx);

    const broadcastPromises = this.providers.map(async (provider, index) => {
      const url = this.rpcUrls[index];
      try {
        const txResponse = await provider.broadcastTransaction(signedTx);
        return {
          url,
          txHash: txResponse.hash,
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
   * Race multiple providers to get transaction receipt confirmation with minimum latency
   * @param {string} txHash 
   * @param {number} confirmations 
   * @param {number} timeoutMs 
   * @returns {Promise<{ receipt: ethers.TransactionReceipt, fastProvider: string }>}
   */
  async waitForReceiptFastest(txHash, confirmations = 1, timeoutMs = 60000) {
    const pollInterval = 350; // ms
    const deadline = Date.now() + timeoutMs;

    return new Promise((resolve, reject) => {
      let resolved = false;

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
