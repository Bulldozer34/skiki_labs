const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { getEthPriceUsd } = require('../utils/priceFetcher');
const logger = require('../utils/logger');

const MINT_HISTORY_FILE = path.resolve(process.cwd(), 'mint-history.json');
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

class MintTracker {
  /**
   * Parse minted Token IDs from TransactionReceipt logs
   * @param {object} receipt Ethers TransactionReceipt
   * @param {string} walletAddress Target minter wallet address
   * @returns {Array<string|number>} Array of token IDs
   */
  static extractTokenIdsFromReceipt(receipt, walletAddress) {
    if (!receipt || !receipt.logs || receipt.logs.length === 0) return [];

    const tokenIds = [];
    const normalizedWallet = walletAddress ? walletAddress.toLowerCase() : null;

    for (const log of receipt.logs) {
      if (!log.topics || log.topics.length < 4) continue;
      if (log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;

      try {
        // Topic 1: from address (must be 0x0 for a mint)
        const fromAddr = ethers.getAddress('0x' + log.topics[1].slice(26)).toLowerCase();
        // Topic 2: to address
        const toAddr = ethers.getAddress('0x' + log.topics[2].slice(26)).toLowerCase();

        // Topic 3: tokenId
        const tokenId = BigInt(log.topics[3]).toString();

        if (fromAddr === ZERO_ADDRESS && (!normalizedWallet || toAddr === normalizedWallet)) {
          tokenIds.push(tokenId);
        }
      } catch (e) {}
    }

    return tokenIds;
  }

  /**
   * Record a structured mint telemetry entry to mint-history.json
   * @param {object} entry
   */
  static async recordMint(entry) {
    try {
      const ethPrice = await getEthPriceUsd().catch(() => null);

      let gasSpentEth = 0;
      let gasPriceGwei = null;
      let gasUsedUnits = null;

      if (entry.receipt) {
        if (entry.receipt.gasUsed && entry.receipt.gasPrice) {
          try {
            const used = BigInt(entry.receipt.gasUsed);
            const price = BigInt(entry.receipt.gasPrice);
            gasSpentEth = Number(used * price) / 1e18;
            gasPriceGwei = (Number(price) / 1e9).toFixed(4);
            gasUsedUnits = used.toString();
          } catch (e) {}
        }
      } else if (entry.gasSpentETH) {
        gasSpentEth = parseFloat(entry.gasSpentETH) || 0;
      }

      const gasSpentUsd = ethPrice && gasSpentEth > 0
        ? `$${(gasSpentEth * ethPrice).toFixed(4)}`
        : null;

      const tokenIds = entry.tokenIds || (entry.receipt ? this.extractTokenIdsFromReceipt(entry.receipt, entry.walletAddress || entry.address) : []);

      const record = {
        id: `mint_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: entry.timestamp || new Date().toISOString(),
        formattedTime: new Date().toLocaleString(),
        network: entry.network || 'Robinhood Chain (4663)',
        contractAddress: entry.contractAddress || entry.target || 'Unknown',
        collectionSlug: entry.collectionSlug || entry.target || 'Unknown',
        mode: entry.mode || 'PUBLIC',
        walletAddress: entry.walletAddress || entry.address || 'Unknown',
        quantity: entry.quantity || tokenIds.length || 1,
        tokenIds: tokenIds,
        status: entry.status || 'SUCCESS',
        txHash: entry.txHash || null,
        blockNumber: entry.blockNumber || entry.receipt?.blockNumber || null,
        gasUsed: gasUsedUnits || entry.gasUsed || null,
        gasPriceGwei: gasPriceGwei || entry.gasPriceGwei || null,
        gasSpentETH: gasSpentEth,
        gasSpentUSD: gasSpentUsd,
        mintPriceETH: entry.mintPriceETH || 0,
        mintDurationMs: entry.mintDurationMs || null,
        details: entry.details || null,
        revertReason: entry.revertReason || null
      };

      let history = [];
      if (fs.existsSync(MINT_HISTORY_FILE)) {
        try {
          const raw = fs.readFileSync(MINT_HISTORY_FILE, 'utf-8');
          const parsed = JSON.parse(raw);
          history = Array.isArray(parsed) ? parsed : [parsed];
        } catch (e) {
          history = [];
        }
      }

      history.push(record);
      fs.writeFileSync(MINT_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf-8');
      logger.info(`[MintTracker] Recorded mint for ${record.walletAddress.slice(0, 6)}... (Tokens: ${tokenIds.join(', ') || 'None'})`);
      return record;
    } catch (err) {
      logger.warn(`[MintTracker] Failed to record mint history: ${err.message}`);
      return null;
    }
  }

  /**
   * Load complete history array from disk
   * @returns {Array<object>}
   */
  static loadHistory() {
    if (!fs.existsSync(MINT_HISTORY_FILE)) return [];
    try {
      const raw = fs.readFileSync(MINT_HISTORY_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      return [];
    }
  }

  /**
   * Compute aggregate performance and speed analytics
   */
  static async getAnalytics() {
    const history = this.loadHistory();
    const ethPrice = await getEthPriceUsd().catch(() => null);

    const realMints = history.filter(m => !String(m.details || '').includes('Testnet Simulation'));
    const successMints = realMints.filter(m => String(m.status).toUpperCase() === 'SUCCESS' || m.receipt?.status === 1);

    let totalNfts = 0;
    let totalGasEth = 0;
    let totalLatencyMs = 0;
    let latencyCount = 0;
    let fastestLatencyMs = Infinity;
    let fastestTx = null;

    const collections = new Map();
    const mintedTokens = []; // { contract, tokenId, wallet, txHash, timestamp }

    for (const m of successMints) {
      const qty = parseInt(m.quantity, 10) || 1;
      totalNfts += qty;

      const gas = parseFloat(m.gasSpentETH) || 0;
      totalGasEth += gas;

      if (m.mintDurationMs && m.mintDurationMs > 0) {
        totalLatencyMs += m.mintDurationMs;
        latencyCount++;
        if (m.mintDurationMs < fastestLatencyMs) {
          fastestLatencyMs = m.mintDurationMs;
          fastestTx = m;
        }
      }

      const contract = (m.contractAddress || 'Unknown').toLowerCase();
      collections.set(contract, (collections.get(contract) || 0) + qty);

      if (m.tokenIds && Array.isArray(m.tokenIds)) {
        m.tokenIds.forEach(id => {
          mintedTokens.push({
            contract: m.contractAddress,
            tokenId: id,
            wallet: m.walletAddress,
            txHash: m.txHash,
            timestamp: m.timestamp
          });
        });
      }
    }

    const avgLatencyMs = latencyCount > 0 ? Math.round(totalLatencyMs / latencyCount) : null;
    const totalGasUsd = ethPrice ? (totalGasEth * ethPrice).toFixed(2) : null;
    const successRatePct = realMints.length > 0
      ? Math.round((successMints.length / realMints.length) * 100)
      : 100;

    return {
      totalAttempts: realMints.length,
      successCount: successMints.length,
      failedCount: realMints.length - successMints.length,
      successRatePct,
      totalNftsMinted: totalNfts,
      totalGasEth: totalGasEth.toFixed(5),
      totalGasUsd: totalGasUsd ? `$${totalGasUsd}` : 'N/A',
      avgLatencyMs,
      fastestLatencyMs: fastestLatencyMs !== Infinity ? fastestLatencyMs : null,
      fastestTx,
      uniqueCollectionsCount: collections.size,
      topCollections: Array.from(collections.entries()).sort((a, b) => b[1] - a[1]),
      mintedTokens
    };
  }
}

module.exports = MintTracker;
