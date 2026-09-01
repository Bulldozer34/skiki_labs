const { runPublicMint } = require('../engines/publicMintEngine');
const { runAllowlistMint } = require('../engines/allowlistMintEngine');
const logger = require('../utils/logger');

/**
 * Shared snipe runner.
 *
 * Builds the `runConfig` shape that both engines expect from plain arguments
 * (no inquirer), then dispatches to the correct engine. This is the single
 * entry point for both the CLI and the future Telegram daemon — duplicating
 * the config construction in two places is how bugs like the missing
 * `runAllowlistMint` wrapper go unnoticed.
 *
 * @param {object} params
 * @param {string} params.mode              'PUBLIC' | 'ALLOWLIST'
 * @param {import('ethers').Wallet[]} params.wallets
 * @param {import('ethers').Provider} params.provider
 * @param {object[]} [params.endpoints]     Multi-RPC endpoint descriptors
 * @param {string[]} [params.rpcUrls]       Flat RPC URL list (fallback)
 * @param {string}   [params.feedUrl]       Sequencer feed WebSocket URL
 * @param {string} params.nftContractAddress
 * @param {string} [params.collectionSlug]  OpenSea slug (allowlist mode)
 * @param {object} params.chain             Chain config object from chains.js
 * @param {number} params.quantity
 * @param {object} params.gasSettings       Output of resolveGasPreset or manual
 * @param {number} [params.startTime]       Unix seconds, 0/null = immediate
 * @param {string} [params.recipientAddress] Auto-forward destination
 * @returns {Promise<object[]>}             Per-wallet result objects
 */
async function runSnipe({
  mode,
  wallets,
  provider,
  endpoints,
  rpcUrls,
  feedUrl,
  nftContractAddress,
  collectionSlug,
  chain,
  quantity,
  gasSettings,
  startTime,
  recipientAddress
}) {
  if (!wallets || wallets.length === 0) {
    throw new Error('No wallets provided.');
  }
  if (!nftContractAddress) {
    throw new Error('No NFT contract address provided.');
  }

  const runConfig = {
    wallets,
    provider,
    endpoints,
    rpcUrls,
    feedUrl,
    nftContractAddress,
    collectionSlug,
    chain,
    quantity,
    gasSettings,
    startTime,
    recipientAddress
  };

  const normalizedMode = (mode || 'PUBLIC').toUpperCase();

  if (normalizedMode === 'PUBLIC') {
    logger.info('Dispatching to Public Mint engine...');
    return await runPublicMint(runConfig);
  } else if (normalizedMode === 'ALLOWLIST' || normalizedMode === 'FCFS') {
    logger.info('Dispatching to Allowlist Mint engine...');
    return await runAllowlistMint(runConfig);
  } else {
    throw new Error(`Unknown mint mode: ${mode}. Expected 'PUBLIC' or 'ALLOWLIST'.`);
  }
}

module.exports = { runSnipe };
