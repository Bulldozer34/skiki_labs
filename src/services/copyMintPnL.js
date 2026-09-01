/**
 * Copy-Mint PnL & Portfolio Engine — Tracks Copy-Mint Performance, Whale Alpha & Secondary Sales.
 *
 * Persists data in `data/copymint_pnl.json` and calculates:
 * - Total NFTs minted across all wallets & drops
 * - Total cost (mint price + gas in ETH & USD)
 * - Secondary sales & realized revenue
 * - Unsold holdings & estimated floor valuation
 * - Net PnL ($ / ETH) and ROI percentage
 * - Per-collection and per-whale profit leaderboards
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { getEthPriceUsd } = require('../utils/priceFetcher');
const logger = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const PNL_STORAGE_FILE = path.join(DATA_DIR, 'copymint_pnl.json');

class CopyMintPnLService {
  constructor() {
    this._ensureStorage();
    this.records = this._load();
  }

  _ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(PNL_STORAGE_FILE)) {
      fs.writeFileSync(PNL_STORAGE_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  _load() {
    try {
      this._ensureStorage();
      const content = fs.readFileSync(PNL_STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(content || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logger.warn(`[CopyMintPnL] Could not load copymint_pnl.json: ${err.message}`);
      return [];
    }
  }

  _save() {
    try {
      this._ensureStorage();
      fs.writeFileSync(PNL_STORAGE_FILE, JSON.stringify(this.records, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[CopyMintPnL] Could not save copymint_pnl.json: ${err.message}`);
    }
  }

  /**
   * Record a new copy-mint execution event
   * @param {object} event
   */
  async recordCopyMint(event) {
    const ethPrice = await getEthPriceUsd().catch(() => 2500) || 2500;
    const contractAddr = (event.targetContract || event.contractAddress || '').toLowerCase();

    const record = {
      id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: Date.now(),
      dateStr: new Date().toISOString(),
      contractAddress: contractAddr,
      collectionName: event.collectionName || 'Unknown Collection',
      collectionSlug: event.collectionSlug || 'unknown',
      collectionImage: event.collectionImage || 'https://opensea.io/static/images/logos/opensea-logo.png',
      whaleWallet: event.whaleWallet || '0x0000000000000000000000000000000000000000',
      whaleLabel: event.whaleLabel || 'Alpha Whale',
      network: event.network || 'Robinhood Chain',
      mintPriceEthPerToken: parseFloat(event.mintPriceEth || '0') || 0,
      totalNftsMinted: parseInt(event.totalNftsMinted || event.quantity || 1, 10),
      walletCount: parseInt(event.walletCount || 1, 10),
      gasSpentEth: parseFloat(event.gasSpentEth || '0.0001') || 0,
      totalCostEth: 0,
      totalCostUsd: 0,
      tokenIds: event.tokenIds || [],
      soldCount: 0,
      realizedRevenueEth: 0,
      realizedRevenueUsd: 0,
      floorPriceEth: parseFloat(event.floorPriceEth || '0.002') || 0.002,
      txHashes: event.txHashes || []
    };

    record.totalCostEth = (record.mintPriceEthPerToken * record.totalNftsMinted) + record.gasSpentEth;
    record.totalCostUsd = record.totalCostEth * ethPrice;

    this.records.push(record);
    this._save();
    return record;
  }

  /**
   * Record a secondary sale for a minted collection
   */
  async recordSale(contractAddress, quantitySold = 1, salePriceEth = 0.003) {
    const ethPrice = await getEthPriceUsd().catch(() => 2500) || 2500;
    const normalized = (contractAddress || '').toLowerCase();
    const entry = this.records.find(r => r.contractAddress === normalized);

    if (entry) {
      entry.soldCount += quantitySold;
      const revEth = quantitySold * salePriceEth;
      entry.realizedRevenueEth += revEth;
      entry.realizedRevenueUsd += revEth * ethPrice;
      this._save();
      return entry;
    }
    return null;
  }

  /**
   * Calculate overall Copy-Mint PnL and breakdown
   */
  async getSummary(targetContract = null) {
    const ethPrice = await getEthPriceUsd().catch(() => 2500) || 2500;
    const records = targetContract
      ? this.records.filter(r => r.contractAddress === targetContract.toLowerCase())
      : this.records;

    let totalMinted = 0;
    let totalSold = 0;
    let totalCostEth = 0;
    let totalRevenueEth = 0;
    let unrealizedFloorEth = 0;

    const collectionsMap = new Map();
    const whalesMap = new Map();

    for (const r of records) {
      totalMinted += r.totalNftsMinted;
      totalSold += r.soldCount;
      totalCostEth += r.totalCostEth;
      totalRevenueEth += r.realizedRevenueEth;

      const unsold = Math.max(0, r.totalNftsMinted - r.soldCount);
      unrealizedFloorEth += unsold * (r.floorPriceEth || 0.002);

      // Group by Collection
      const cKey = r.contractAddress;
      if (!collectionsMap.has(cKey)) {
        collectionsMap.set(cKey, {
          contractAddress: r.contractAddress,
          collectionName: r.collectionName,
          collectionImage: r.collectionImage,
          whaleLabel: r.whaleLabel,
          totalMinted: 0,
          soldCount: 0,
          holdingCount: 0,
          totalCostEth: 0,
          totalRevenueEth: 0,
          floorPriceEth: r.floorPriceEth,
          netProfitEth: 0,
          netProfitUsd: 0,
          roiPct: 0
        });
      }
      const c = collectionsMap.get(cKey);
      c.totalMinted += r.totalNftsMinted;
      c.soldCount += r.soldCount;
      c.holdingCount = Math.max(0, c.totalMinted - c.soldCount);
      c.totalCostEth += r.totalCostEth;
      c.totalRevenueEth += r.realizedRevenueEth;

      // Group by Whale
      const wKey = r.whaleWallet.toLowerCase();
      if (!whalesMap.has(wKey)) {
        whalesMap.set(wKey, {
          whaleWallet: r.whaleWallet,
          whaleLabel: r.whaleLabel,
          dropsCount: 0,
          totalMinted: 0,
          netProfitEth: 0,
          netProfitUsd: 0
        });
      }
      const w = whalesMap.get(wKey);
      w.dropsCount += 1;
      w.totalMinted += r.totalNftsMinted;
    }

    const totalCostUsd = totalCostEth * ethPrice;
    const totalRevenueUsd = totalRevenueEth * ethPrice;
    const unrealizedFloorUsd = unrealizedFloorEth * ethPrice;
    const netProfitEth = (totalRevenueEth + unrealizedFloorEth) - totalCostEth;
    const netProfitUsd = netProfitEth * ethPrice;
    const roiPct = totalCostEth > 0 ? ((netProfitEth / totalCostEth) * 100) : (netProfitEth > 0 ? 100 : 0);

    // Finalize Collection Stats
    const collectionList = Array.from(collectionsMap.values()).map(c => {
      const cFloorVal = c.holdingCount * (c.floorPriceEth || 0.002);
      c.netProfitEth = (c.totalRevenueEth + cFloorVal) - c.totalCostEth;
      c.netProfitUsd = c.netProfitEth * ethPrice;
      c.roiPct = c.totalCostEth > 0 ? ((c.netProfitEth / c.totalCostEth) * 100) : (c.netProfitEth > 0 ? 100 : 0);
      return c;
    }).sort((a, b) => b.netProfitEth - a.netProfitEth);

    return {
      ethPriceUsd: ethPrice,
      totalDrops: records.length,
      totalMinted,
      totalSold,
      holdingCount: Math.max(0, totalMinted - totalSold),
      totalCostEth: parseFloat(totalCostEth.toFixed(4)),
      totalCostUsd: parseFloat(totalCostUsd.toFixed(2)),
      totalRevenueEth: parseFloat(totalRevenueEth.toFixed(4)),
      totalRevenueUsd: parseFloat(totalRevenueUsd.toFixed(2)),
      unrealizedFloorEth: parseFloat(unrealizedFloorEth.toFixed(4)),
      unrealizedFloorUsd: parseFloat(unrealizedFloorUsd.toFixed(2)),
      netProfitEth: parseFloat(netProfitEth.toFixed(4)),
      netProfitUsd: parseFloat(netProfitUsd.toFixed(2)),
      roiPct: parseFloat(roiPct.toFixed(1)),
      isProfitable: netProfitEth >= 0,
      topCollections: collectionList,
      topWhales: Array.from(whalesMap.values())
    };
  }

  getRecords() {
    return [...this.records];
  }
}

module.exports = new CopyMintPnLService();
