const inquirer = require('inquirer');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Wallet Service for managing private keys, nonces, and balances
 * Includes in-memory sequential nonce queue for 0-latency multi-tx minting
 */
const WalletService = {
  // In-memory nonce tracking: address.toLowerCase() -> current nonce
  _nonceCache: new Map(),

  /**
   * Prompt user for private keys — paste manually or load from .txt file
   * @returns {Promise<ethers.Wallet[]>}
   */
  async promptWalletKeys() {
    const { keySource } = await inquirer.prompt([
      {
        type: 'list',
        name: 'keySource',
        message: 'How would you like to load private keys?',
        choices: [
          { name: '📋 Paste keys manually (one at a time)', value: 'PASTE' },
          { name: '📁 Load from .txt file', value: 'FILE' }
        ]
      }
    ]);

    if (keySource === 'FILE') {
      return await this._promptFileLoad();
    }

    return await this._promptManualPaste();
  },

  /**
   * Prompt for .txt file path and load keys from it
   * @returns {Promise<ethers.Wallet[]>}
   */
  async _promptFileLoad() {
    const { filePath } = await inquirer.prompt([
      {
        type: 'input',
        name: 'filePath',
        message: 'Path to .txt file (one private key per line):',
        validate: input => {
          const resolved = path.resolve(input.trim());
          if (!fs.existsSync(resolved)) return `File not found: ${resolved}`;
          return true;
        }
      }
    ]);

    return this.loadFromFile(filePath.trim());
  },

  /**
   * Original manual paste flow
   * @returns {Promise<ethers.Wallet[]>}
   */
  async _promptManualPaste() {
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
   * Load private keys from a .txt file (one key per line)
   * Skips blank lines and lines starting with #
   * @param {string} filePath
   * @returns {ethers.Wallet[]}
   */
  loadFromFile(filePath) {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, 'utf-8');
    const lines = content.split(/[\r\n]+/).map(s => s.trim()).filter(Boolean);

    const wallets = [];
    let lineNum = 0;

    for (const line of lines) {
      lineNum++;

      // Skip comments
      if (line.startsWith('#') || line.startsWith('//')) continue;

      let cleanKey = line;
      if (!cleanKey.startsWith('0x')) {
        cleanKey = '0x' + cleanKey;
      }

      try {
        const wallet = new ethers.Wallet(cleanKey);
        if (!wallets.some(w => w.address.toLowerCase() === wallet.address.toLowerCase())) {
          logger.success(`[Wallet #${wallets.length + 1}] ${wallet.address}`);
          wallets.push(wallet);
        }
      } catch (err) {
        logger.error(`Line ${lineNum}: Invalid key format (${err.message})`);
      }
    }

    if (wallets.length === 0) {
      logger.warn('No valid wallets found in file.');
    } else {
      logger.success(`Loaded ${wallets.length} wallet(s) from ${path.basename(resolved)}`);
    }

    return wallets;
  },

  /**
   * Generate N random Ethereum wallets
   * @param {number} count - Number of wallets to generate
   * @returns {{ wallets: ethers.Wallet[], entries: Array<{index: number, address: string, privateKey: string}> }}
   */
  generateWallets(count) {
    const wallets = [];
    const entries = [];

    for (let i = 0; i < count; i++) {
      const wallet = ethers.Wallet.createRandom();
      wallets.push(wallet);
      entries.push({
        index: i + 1,
        address: wallet.address,
        privateKey: wallet.privateKey
      });
    }

    return { wallets, entries };
  },

  /**
   * Save generated wallet keys to a .txt file
   * @param {Array<{address: string, privateKey: string}>} entries
   * @param {string} [outputDir] - Directory to save in (defaults to cwd)
   * @returns {string} Path to saved file
   */
  saveWalletsToFile(entries, outputDir) {
    const timestamp = new Date().toISOString().replace(/[:\-T]/g, '').slice(0, 14);
    const filename = `wallets_${timestamp}.txt`;
    const dir = outputDir || process.cwd();
    const filePath = path.join(dir, filename);

    const lines = [
      '# Generated Wallets — NFT Mint Bot',
      `# Created: ${new Date().toLocaleString()}`,
      `# Count: ${entries.length}`,
      '#',
      '# One private key per line. Use with: node cli.js → Load from .txt file',
      '#',
      ...entries.map(e => e.privateKey),
      ''
    ];

    fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
    return filePath;
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

