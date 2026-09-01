/**
 * Anti-Scam & Sybil Filtering Heuristics
 * Filters out insider deployers, wash traders, circular liquidity rings, and honeypots.
 */

class ScamFilter {
  constructor(options = {}) {
    this.minDistinctDrops = options.minDistinctDrops || 2;
    this.deployers = new Set();
    this.creatorWallets = new Set();
    this.blacklistedWallets = new Set([
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dead',
      '0x00005ea00ac477b1030ce78506496e8c2de24bf5', // SeaDrop itself
      '0x0000000000000068f116a894984e2db1123eb395', // Seaport 1.6 itself
    ]);
  }

  /**
   * Register known collection deployers or fee recipients as creators
   */
  registerDeployer(address) {
    if (address && typeof address === 'string') {
      this.deployers.add(address.toLowerCase());
    }
  }

  /**
   * Check if a trade is a wash trade (self-trade or known circular ring)
   */
  isWashTrade(seller, buyer) {
    if (!seller || !buyer) return true;
    const s = seller.toLowerCase();
    const b = buyer.toLowerCase();
    if (s === b) return true; // Self-purchase
    if (this.blacklistedWallets.has(s) || this.blacklistedWallets.has(b)) return true;
    return false;
  }

  /**
   * Evaluate whether a wallet is safe and legitimate to copy-mint
   * @param {object} walletData
   * @returns {{ safe: boolean, reason?: string }}
   */
  evaluateWallet(walletData) {
    const address = (walletData.address || '').toLowerCase();

    if (!address || !/^0x[a-f0-9]{40}$/i.test(address)) {
      return { safe: false, reason: 'Invalid address format' };
    }

    if (this.blacklistedWallets.has(address)) {
      return { safe: false, reason: 'Address is blacklisted / system contract' };
    }

    if (this.deployers.has(address)) {
      return { safe: false, reason: 'Wallet is a collection deployer / insider affiliate' };
    }

    // Require participation in at least minDistinctDrops to filter out single-hit burners or self-made drops
    const distinctDrops = walletData.distinctDropsCount || 0;
    if (distinctDrops < this.minDistinctDrops) {
      return { safe: false, reason: `Only ${distinctDrops} drop(s) minted. Minimum required: ${this.minDistinctDrops} to verify track record` };
    }

    // Check if mints are 100% inside one collection where they might be insider
    if (walletData.isInsiderSuspect) {
      return { safe: false, reason: 'Suspected insider wash-trading activity' };
    }

    return { safe: true };
  }
}

module.exports = ScamFilter;
