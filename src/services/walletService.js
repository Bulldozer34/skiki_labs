const inquirer = require('inquirer');
const { ethers } = require('ethers');
const logger = require('../utils/logger');

/**
 * Wallet Service for managing private keys, nonces, and balances
 * Includes in-memory sequential nonce queue for 0-latency multi-tx minting
 */
const WalletService = {
  // In-memory nonce tracking: address.toLowerCase() -> current nonce
  _nonceCache: new Map(),

  /**
   * Prompt user for private keys (supports single key, one-by-one, or multi-line paste)
   * @returns {Promise<ethers.Wallet[]>}
   */
  async promptWalletKeys() {
    const wallets = [];
    logger.info('Paste your private key(s). You can paste one per line or multiple lines.');
    logger.info('Press Enter on a blank line when finished.');

    let count = 1;
    while (true) {
      const answers = await inquirer.prompt([{
        type: 'password',
        name: 'pk',
        message: `Private Key #${count} (or blank to finish):`,
        mask: '*'
      }]);

      const input = answers.pk ? answers.pk.trim() : '';

      if (!input) {
        break; // Finish when input is blank
      }

      // Support multi-line pastes if user pasted multiple keys into the prompt
      const lines = input.split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);

      for (const rawKey of lines) {
        let cleanKey = rawKey;
        if (!cleanKey.startsWith('0x')) {
          cleanKey = '0x' + cleanKey;
        }

        try {
          const wallet = new ethers.Wallet(cleanKey);
          // Avoid duplicate wallets in the same session
          if (!wallets.some(w => w.address.toLowerCase() === wallet.address.toLowerCase())) {
            logger.success(`[Wallet #${wallets.length + 1}] Added: ${wallet.address}`);
            wallets.push(wallet);
            count++;
          }
        } catch (err) {
          // Never log raw key data or substrings to preserve entropy & security
          logger.error(`Failed to load private key #${count}: Invalid key format or checksum (${err.message})`);
        }
      }
    }

    if (wallets.length === 0) {
      logger.warn('No valid wallets provided.');
    } else {
      logger.info(`Loaded ${wallets.length} wallet(s) for this session.`);
    }

    return wallets;
  },

  /**
   * Check ETH balances for all wallets concurrently
   * @param {ethers.Wallet[]} wallets 
   * @param {ethers.Provider} provider 
   * @returns {Promise<Array<{address: string, balance: string, balanceWei: bigint}>>}
   */
  async checkBalances(wallets, provider) {
    logger.info(`Checking balances for ${wallets.length} wallet(s)...`);
    const balancePromises = wallets.map(async (w) => {
      try {
        const balanceWei = await provider.getBalance(w.address);
        const formatted = ethers.formatEther(balanceWei);
        const shortAddr = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
        logger.info(`  ${shortAddr}: ${formatted} ETH`);
        return {
          address: w.address,
          balance: formatted,
          balanceWei
        };
      } catch (error) {
        logger.error(`Error checking balance for ${w.address}: ${error.message}`);
        return {
          address: w.address,
          balance: '0.0',
          balanceWei: 0n
        };
      }
    });

    return await Promise.all(balancePromises);
  },

  /**
   * Prefetch nonces for all wallets concurrently and cache them in memory
   * @param {ethers.Wallet[]} wallets 
   * @param {ethers.Provider} provider 
   * @returns {Promise<Map<string, number>>}
   */
  async prefetchNonces(wallets, provider) {
    const nonceMap = new Map();
    
    const promises = wallets.map(async (w) => {
      const addrKey = w.address.toLowerCase();
      try {
        const nonce = await provider.getTransactionCount(w.address, 'pending');
        nonceMap.set(addrKey, nonce);
        this._nonceCache.set(addrKey, nonce);
      } catch (error) {
        logger.error(`Failed to fetch nonce for ${w.address}: ${error.message}`);
        const fallbackNonce = await provider.getTransactionCount(w.address, 'latest').catch(() => 0);
        nonceMap.set(addrKey, fallbackNonce);
        this._nonceCache.set(addrKey, fallbackNonce);
      }
    });

    await Promise.all(promises);
    return nonceMap;
  },

  /**
   * Get next nonce from in-memory cache, auto-incrementing sequentially
   * @param {string} address 
   * @returns {number|null}
   */
  consumeNonce(address) {
    const addrKey = address.toLowerCase();
    if (!this._nonceCache.has(addrKey)) return null;
    const current = this._nonceCache.get(addrKey);
    this._nonceCache.set(addrKey, current + 1);
    return current;
  },

  /**
   * Peek current nonce without incrementing
   * @param {string} address 
   * @returns {number|null}
   */
  peekNonce(address) {
    return this._nonceCache.get(address.toLowerCase()) ?? null;
  },

  /**
   * Set or override current nonce in memory
   * @param {string} address 
   * @param {number} nonce 
   */
  setNonce(address, nonce) {
    this._nonceCache.set(address.toLowerCase(), nonce);
  },

  /**
   * Connect all wallets to a provider
   * @param {ethers.Wallet[]} wallets 
   * @param {ethers.Provider} provider 
   * @returns {ethers.Wallet[]} Connected wallets
   */
  connectWallets(wallets, provider) {
    return wallets.map(w => w.connect(provider));
  }
};

module.exports = WalletService;

