const { ethers } = require('ethers');
const chalk = require('chalk');
const Table = require('cli-table3');
const logger = require('../utils/logger');
const authService = require('../services/authService');
const connectionManager = require('../services/connectionManager');
const { fetchSingleCalldata } = require('./allowlistMintEngine');

// Error patterns used to classify why a wallet was rejected
const DENIED_PATTERNS = [
  /not.*allowlist/i, /not.*whitelist/i, /MerkleProofInvalid/i,
  /invalid.*proof/i, /not eligible/i, /403/
];

const NOT_LIVE_PATTERNS = [
  /NotActive/i, /not.*active/i, /not yet started/i, /MintNotLive/i,
  /not.*live/i, /stage.*not.*open/i
];

const RATE_LIMIT_PATTERNS = [
  /429/i, /rate.*limit/i, /too many requests/i, /throttl/i
];

/**
 * Classify an API error into a human-readable eligibility status
 * @param {string} errorMsg - The raw error string from the API
 * @returns {{ status: string, label: string, detail: string }}
 */
function classifyError(errorMsg) {
  const msg = errorMsg || 'Unknown error';

  for (const pattern of DENIED_PATTERNS) {
    if (pattern.test(msg)) {
      return { status: 'DENIED', label: chalk.red('❌ DENIED'), detail: msg };
    }
  }

  for (const pattern of NOT_LIVE_PATTERNS) {
    if (pattern.test(msg)) {
      return { status: 'NOT_LIVE', label: chalk.yellow('⏳ NOT_LIVE'), detail: msg };
    }
  }

  for (const pattern of RATE_LIMIT_PATTERNS) {
    if (pattern.test(msg)) {
      return { status: 'RATE_LIMITED', label: chalk.yellow('⚠️  RATE_LIMITED'), detail: msg };
    }
  }

  return { status: 'ERROR', label: chalk.yellow('⚠️  ERROR'), detail: msg };
}

/**
 * Check eligibility for all wallets against an OpenSea Allowlist/FCFS drop.
 * 
 * Authenticates each wallet via SIWE, then calls the OpenSea Drops API
 * to see if calldata is returned (eligible) or rejected (denied/not live).
 * 
 * @param {object} config
 * @param {ethers.Wallet[]} config.wallets - Array of ethers Wallet objects
 * @param {string} config.collectionSlug - OpenSea drop slug
 * @param {number} [config.quantity=1] - Mint quantity to check
 * @returns {Promise<object[]>} Array of result objects
 */
async function checkAllWallets(config) {
  const { wallets, collectionSlug, quantity } = config;

  logger.separator();
  logger.info('Eligibility Pre-Check Mode');
  logger.info(`Collection: ${collectionSlug}`);
  logger.info(`Wallets: ${wallets.length}`);
  logger.info(`Quantity: ${quantity || 1}`);
  logger.separator();

  // 1. Pre-warm OpenSea sockets
  connectionManager.preWarmSockets(['https://api.opensea.io']).catch(() => {});

  // 2. Authenticate all wallets via SIWE
  logger.info('Authenticating wallets with OpenSea SIWE...');
  await authService.authenticateAll(wallets);

  const authHeadersByAddress = new Map();
  for (const wallet of wallets) {
    const headers = authService.getAuthHeaders(wallet.address);
    if (headers) {
      authHeadersByAddress.set(wallet.address.toLowerCase(), headers);
    }
  }

  const fallbackAuthHeaders = authHeadersByAddress.values().next().value || {};

  // 3. Check each wallet against the Drops API
  logger.info('Checking eligibility via OpenSea Drops API...');
  logger.separator();

  const results = [];

  const settled = await Promise.allSettled(wallets.map(async (wallet) => {
    const headers = authHeadersByAddress.get(wallet.address.toLowerCase()) || fallbackAuthHeaders;

    try {
      const calldata = await fetchSingleCalldata(wallet, {
        collectionSlug,
        quantity: quantity || 1
      }, headers);

      // If we got valid calldata back, the wallet is eligible
      const toAddr = calldata.to ? `${calldata.to.slice(0, 8)}...` : '?';
      return {
        address: wallet.address,
        status: 'ELIGIBLE',
        label: chalk.green('✅ ELIGIBLE'),
        detail: `Calldata ready (to: ${toAddr})`
      };
    } catch (error) {
      const apiMessage = error.response?.data?.message
        || error.response?.data?.detail
        || error.response?.data?.error;
      const httpStatus = error.response?.status ? `HTTP ${error.response.status}: ` : '';
      const rawError = `${httpStatus}${apiMessage || error.message}`;

      const classified = classifyError(rawError);
      return {
        address: wallet.address,
        ...classified
      };
    }
  }));

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      results.push(result.value);
    } else {
      results.push({
        address: 'Unknown',
        status: 'ERROR',
        label: chalk.yellow('⚠️  ERROR'),
        detail: result.reason?.message || 'Promise rejected'
      });
    }
  }

  // 4. Print results table
  const table = new Table({
    head: [
      chalk.white.bold('Wallet'),
      chalk.white.bold('Status'),
      chalk.white.bold('Detail')
    ],
    colWidths: [22, 16, 50],
    style: { head: [], border: [] }
  });

  for (const r of results) {
    const shortAddr = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
    table.push([shortAddr, r.label, r.detail]);
  }

  console.log('');
  console.log(table.toString());
  console.log('');

  // 5. Print summary counts
  const eligible = results.filter(r => r.status === 'ELIGIBLE').length;
  const denied = results.filter(r => r.status === 'DENIED').length;
  const notLive = results.filter(r => r.status === 'NOT_LIVE').length;
  const errors = results.filter(r => r.status === 'ERROR' || r.status === 'RATE_LIMITED').length;

  const parts = [];
  if (eligible > 0) parts.push(chalk.green(`${eligible} eligible`));
  if (denied > 0) parts.push(chalk.red(`${denied} denied`));
  if (notLive > 0) parts.push(chalk.yellow(`${notLive} not live yet`));
  if (errors > 0) parts.push(chalk.yellow(`${errors} error(s)`));

  logger.info(`Summary: ${parts.join(', ')}`);

  if (notLive > 0) {
    logger.info('Tip: "NOT_LIVE" means the drop stage hasn\'t opened — your wallets may still be eligible once it starts.');
  }

  if (eligible > 0) {
    logger.success(`${eligible}/${wallets.length} wallet(s) confirmed eligible. You\'re good to run the full mint.`);
  } else if (notLive > 0 && denied === 0) {
    logger.warn('Drop is not live yet. Run this check again closer to the start time.');
  } else {
    logger.error('No eligible wallets found. Check your collection slug and wallet addresses.');
  }

  logger.separator();
  return results;
}

module.exports = { checkAllWallets };
