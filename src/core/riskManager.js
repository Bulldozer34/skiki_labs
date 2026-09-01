const fs = require('fs');
const path = require('path');
const { getEthPriceUsd } = require('../utils/priceFetcher');
const logger = require('../utils/logger');

/**
 * Risk Manager — the single authorization gate every buy path must pass.
 *
 * Every spend (mint, floor buy, copy-trade) calls `authorize()` before
 * broadcasting. The manager checks per-NFT price caps, daily budget,
 * per-collection limits, and slippage. After a fill, `record()` persists
 * the actual spend so caps survive restarts.
 *
 * USDG amounts compare directly against USD caps (÷1e6, no oracle needed).
 * ETH-priced mints convert via priceFetcher.getEthPriceUsd().
 *
 * State persists to risk-state.json and resets daily at 00:00 UTC.
 */

const STATE_FILE = path.resolve(process.cwd(), 'risk-state.json');

/** BigInt-safe JSON replacer */
const bigIntReplacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

/**
 * Read caps from .env with sensible defaults.
 */
function loadCaps() {
  return {
    maxPriceUsd:       parseFloat(process.env.RISK_MAX_PRICE_USD       || '0.50'),
    dailyBudgetUsd:    parseFloat(process.env.RISK_DAILY_BUDGET_USD    || '15.00'),
    maxPerCollection:  parseInt(process.env.RISK_MAX_PER_COLLECTION    || '1', 10),
    maxSlippagePct:    parseFloat(process.env.RISK_MAX_SLIPPAGE_PCT    || '10'),
    takeProfitPct:     parseFloat(process.env.RISK_TAKE_PROFIT_PCT     || '50'),
    stopLossPct:       parseFloat(process.env.RISK_STOP_LOSS_PCT       || '25'),
    whaleConviction:   parseInt(process.env.RISK_WHALE_CONVICTION      || '2', 10)
  };
}

/**
 * Get today's date key in UTC for daily reset.
 * @returns {string} e.g. '2026-08-31'
 */
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

class RiskManager {
  constructor() {
    this.caps = loadCaps();
    this.state = this._loadState();
  }

  /**
   * Reload caps from environment (useful after .env hot-reload).
   */
  reloadCaps() {
    this.caps = loadCaps();
    return this.caps;
  }

  // ---------------------------------------------------------------------------
  // State persistence
  // ---------------------------------------------------------------------------

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        // Reset if the day has rolled over
        if (parsed.dateUtc !== todayUtc()) {
          return this._freshState();
        }
        return parsed;
      }
    } catch (err) {
      logger.warn(`[RiskManager] Could not load state: ${err.message}`);
    }
    return this._freshState();
  }

  _freshState() {
    return {
      dateUtc: todayUtc(),
      spentTodayUsd: 0,
      /** collection slug/address → { count, totalSpentUsd } */
      collections: {},
      /** Individual transaction records for audit trail */
      records: []
    };
  }

  _saveState() {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, bigIntReplacer, 2), 'utf8');
    } catch (err) {
      logger.warn(`[RiskManager] Could not save state: ${err.message}`);
    }
  }

  _ensureFreshDay() {
    if (this.state.dateUtc !== todayUtc()) {
      this.state = this._freshState();
      this._saveState();
    }
  }

  // ---------------------------------------------------------------------------
  // Price normalization
  // ---------------------------------------------------------------------------

  /**
   * Convert a price to USD for comparison against caps.
   *
   * @param {number|string} unitPrice  Price per NFT
   * @param {string} currency          'USD' | 'USDG' | 'ETH'
   * @param {number} [ethPriceUsd]     Current ETH/USD rate (required for ETH)
   * @returns {number} Price in USD
   */
  _toUsd(unitPrice, currency, ethPriceUsd) {
    const price = Number(unitPrice);
    const cur = (currency || 'ETH').toUpperCase();

    if (cur === 'USD' || cur === 'USDG') {
      // USDG is a 6-decimal stablecoin. If the caller already converted to
      // human units, the number is already in dollars. If they passed raw
      // token units (e.g. 550000), divide by 1e6.
      return price > 1000 ? price / 1e6 : price;
    }

    if (cur === 'ETH' || cur === 'WETH') {
      if (!ethPriceUsd || ethPriceUsd <= 0) {
        logger.warn('[RiskManager] No ETH price available — cannot check USD caps for ETH-priced item.');
        return 0;
      }
      return price * ethPriceUsd;
    }

    // Unknown currency — let it through with a warning
    logger.warn(`[RiskManager] Unknown currency "${currency}" — treating price as USD.`);
    return price;
  }

  // ---------------------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------------------

  /**
   * Check whether a spend is allowed under current caps.
   *
   * @param {object} params
   * @param {string} params.kind         'mint' | 'buy' | 'copy-mint' | 'copy-trade'
   * @param {string} [params.chain]       Chain identifier
   * @param {string} params.collection    Collection slug or contract address
   * @param {number|string} params.unitPrice   Price per NFT
   * @param {string} params.currency      'USD' | 'USDG' | 'ETH'
   * @param {number} [params.quantity=1]
   * @returns {Promise<{ ok: boolean, requiresConfirm: boolean, reason: string|null, spentToday: number, remainingBudget: number, priceUsd: number }>}
   */
  async authorize({ kind, chain, collection, unitPrice, currency, quantity = 1 }) {
    this._ensureFreshDay();

    // Fetch ETH price if needed
    const cur = (currency || 'ETH').toUpperCase();
    let ethPriceUsd = null;
    if (cur === 'ETH' || cur === 'WETH') {
      ethPriceUsd = await getEthPriceUsd();
    }

    const priceUsd = this._toUsd(unitPrice, currency, ethPriceUsd);
    const totalCostUsd = priceUsd * quantity;
    const collectionKey = (collection || '').toLowerCase();

    const spentToday = this.state.spentTodayUsd;
    const remainingBudget = Math.max(0, this.caps.dailyBudgetUsd - spentToday);

    const result = {
      ok: true,
      requiresConfirm: false,
      reason: null,
      spentToday,
      remainingBudget,
      priceUsd: Math.round(priceUsd * 100) / 100
    };

    // 1. Daily budget check
    if (spentToday + totalCostUsd > this.caps.dailyBudgetUsd) {
      result.ok = false;
      result.reason = `Daily budget exhausted: $${spentToday.toFixed(2)} spent / $${this.caps.dailyBudgetUsd.toFixed(2)} cap. This ${kind} would cost $${totalCostUsd.toFixed(2)}.`;
      return result;
    }

    // 2. Per-collection limit
    if (collectionKey) {
      const collectionState = this.state.collections[collectionKey] || { count: 0, totalSpentUsd: 0 };
      if (collectionState.count + quantity > this.caps.maxPerCollection) {
        result.ok = false;
        result.reason = `Per-collection limit reached: ${collectionState.count}/${this.caps.maxPerCollection} already bought from "${collection}".`;
        return result;
      }
    }

    // 3. Price cap — over cap requires manual confirmation
    if (priceUsd > this.caps.maxPriceUsd) {
      result.requiresConfirm = true;
      result.reason = `Price $${priceUsd.toFixed(2)} exceeds cap $${this.caps.maxPriceUsd.toFixed(2)} — waiting for manual confirmation.`;
      // ok stays true — the caller decides whether to prompt or reject
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Recording
  // ---------------------------------------------------------------------------

  /**
   * Record an actual spend after a fill (successful mint or purchase).
   *
   * @param {object} params
   * @param {string} params.kind
   * @param {string} params.collection
   * @param {number|string} params.unitPrice
   * @param {string} params.currency
   * @param {number} [params.quantity=1]
   * @param {string} [params.txHash]
   * @param {string} [params.wallet]
   */
  async record({ kind, collection, unitPrice, currency, quantity = 1, txHash, wallet }) {
    this._ensureFreshDay();

    const cur = (currency || 'ETH').toUpperCase();
    let ethPriceUsd = null;
    if (cur === 'ETH' || cur === 'WETH') {
      ethPriceUsd = await getEthPriceUsd();
    }

    const priceUsd = this._toUsd(unitPrice, currency, ethPriceUsd);
    const totalCostUsd = priceUsd * quantity;
    const collectionKey = (collection || '').toLowerCase();

    // Update daily total
    this.state.spentTodayUsd += totalCostUsd;

    // Update per-collection
    if (collectionKey) {
      if (!this.state.collections[collectionKey]) {
        this.state.collections[collectionKey] = { count: 0, totalSpentUsd: 0 };
      }
      this.state.collections[collectionKey].count += quantity;
      this.state.collections[collectionKey].totalSpentUsd += totalCostUsd;
    }

    // Audit trail
    this.state.records.push({
      timestamp: new Date().toISOString(),
      kind,
      collection,
      unitPriceUsd: priceUsd,
      quantity,
      totalCostUsd,
      currency,
      txHash: txHash || null,
      wallet: wallet || null
    });

    this._saveState();
  }

  // ---------------------------------------------------------------------------
  // Take-profit / Stop-loss thresholds
  // ---------------------------------------------------------------------------

  /**
   * Calculate the take-profit listing price for a given cost basis.
   * @param {number} costBasisUsd
   * @returns {number} Listing price in USD
   */
  takeProfitPrice(costBasisUsd) {
    return costBasisUsd * (1 + this.caps.takeProfitPct / 100);
  }

  /**
   * Check whether the current mark price has triggered stop-loss.
   * @param {number} costBasisUsd
   * @param {number} currentPriceUsd
   * @returns {boolean}
   */
  isStopLossTriggered(costBasisUsd, currentPriceUsd) {
    if (costBasisUsd <= 0) return false;
    const drawdownPct = ((costBasisUsd - currentPriceUsd) / costBasisUsd) * 100;
    return drawdownPct >= this.caps.stopLossPct;
  }

  /**
   * Check whale conviction threshold.
   * @param {number} itemsFromCollection Number of items a whale bought from this collection
   * @returns {boolean} True if whale is above conviction threshold
   */
  meetsWhaleConviction(itemsFromCollection) {
    return itemsFromCollection >= this.caps.whaleConviction;
  }

  // ---------------------------------------------------------------------------
  // Slippage
  // ---------------------------------------------------------------------------

  /**
   * Check if the execution price is within slippage tolerance.
   * @param {number} expectedPriceUsd
   * @param {number} actualPriceUsd
   * @returns {{ ok: boolean, slippagePct: number }}
   */
  checkSlippage(expectedPriceUsd, actualPriceUsd) {
    if (expectedPriceUsd <= 0) return { ok: true, slippagePct: 0 };
    const slippagePct = ((actualPriceUsd - expectedPriceUsd) / expectedPriceUsd) * 100;
    return {
      ok: slippagePct <= this.caps.maxSlippagePct,
      slippagePct: Math.round(slippagePct * 100) / 100
    };
  }

  // ---------------------------------------------------------------------------
  // Status / Dashboard
  // ---------------------------------------------------------------------------

  /**
   * Get current risk status for display.
   * @returns {object}
   */
  getStatus() {
    this._ensureFreshDay();
    return {
      caps: { ...this.caps },
      spentTodayUsd: Math.round(this.state.spentTodayUsd * 100) / 100,
      remainingBudgetUsd: Math.round(Math.max(0, this.caps.dailyBudgetUsd - this.state.spentTodayUsd) * 100) / 100,
      collectionsToday: Object.keys(this.state.collections).length,
      transactionsToday: this.state.records.length,
      dateUtc: this.state.dateUtc
    };
  }
}

/** Singleton instance — all callers share the same gate. */
const riskManager = new RiskManager();

module.exports = { RiskManager, riskManager };
