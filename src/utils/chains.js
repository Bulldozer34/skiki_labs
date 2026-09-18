/**
 * Chain Configurations (Prioritizing Ethereum Mainnet, Robinhood Mainnet & Robinhood Testnet)
 *
 * Robinhood Chain is an Arbitrum Nitro (Orbit) chain, and its sequencer orders
 * transactions strictly first-come-first-served — gas cannot buy queue position.
 * That makes the *role* of each endpoint matter, so they are split out here
 * rather than collapsed into one `defaultRpc`:
 *
 *   - `sequencerRpc` — the sequencer's write ingress. The only node that can
 *     order a transaction; every other endpoint merely forwards to it, so this
 *     is the shortest path that exists. Not behind Cloudflare (resolves straight
 *     to AWS us-east-2) and measured ~19ms faster than `defaultRpc`. Accepts
 *     **only** `eth_sendRawTransaction` — every read method returns
 *     "does not exist/is not available", hence `broadcastOnly` below.
 *   - `defaultRpc` — a read replica with the full method set, Cloudflare-fronted.
 *   - `feedUrl` — Nitro sequencer feed: a push stream of what has already been
 *     ordered. Removes the round-trip from drop detection and inclusion checks.
 *
 * Endpoints probed live 2026-08-31 against mainnet; `nitro/v3.11.3`, ArbOS 61.
 */

const CHAINS = {
  ROBINHOOD_TESTNET: {
    name: 'Robinhood Chain Testnet (Free $0 Faucet)',
    chainId: 46630,
    symbol: 'ETH',
    defaultRpc: 'https://rpc.testnet.chain.robinhood.com/rpc',
    sequencerRpc: 'https://sequencer.testnet.chain.robinhood.com',
    feedUrl: 'wss://feed.testnet.chain.robinhood.com',
    alchemyPrefix: 'robinhood-testnet',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  ROBINHOOD: {
    name: 'Robinhood Chain (Mainnet L2)',
    chainId: 4663,
    symbol: 'ETH',
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
    sequencerRpc: 'https://sequencer.mainnet.chain.robinhood.com',
    feedUrl: 'wss://feed.mainnet.chain.robinhood.com',
    alchemyPrefix: 'robinhood-mainnet',
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  ETHEREUM: {
    name: 'Ethereum Mainnet',
    chainId: 1,
    symbol: 'ETH',
    defaultRpc: 'https://eth.llamarpc.com',
    alchemyPrefix: 'eth-mainnet',
    explorerUrl: 'https://etherscan.io',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  SEPOLIA: {
    name: 'Ethereum Sepolia Testnet',
    chainId: 11155111,
    symbol: 'ETH',
    defaultRpc: 'https://ethereum-sepolia-rpc.publicnode.com',
    alchemyPrefix: 'eth-sepolia',
    explorerUrl: 'https://sepolia.etherscan.io',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  BASE: {
    name: 'Base',
    chainId: 8453,
    symbol: 'ETH',
    defaultRpc: 'https://mainnet.base.org',
    alchemyPrefix: 'base-mainnet',
    explorerUrl: 'https://basescan.org',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  ARBITRUM: {
    name: 'Arbitrum One',
    chainId: 42161,
    symbol: 'ETH',
    defaultRpc: 'https://arb1.arbitrum.io/rpc',
    alchemyPrefix: 'arb-mainnet',
    explorerUrl: 'https://arbiscan.io',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  OPTIMISM: {
    name: 'Optimism Mainnet',
    chainId: 10,
    symbol: 'ETH',
    defaultRpc: 'https://mainnet.optimism.io',
    alchemyPrefix: 'opt-mainnet',
    explorerUrl: 'https://optimistic.etherscan.io',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  ARC: {
    name: 'Arc Network (Circle L1)',
    chainId: 5042,
    symbol: 'USDC',
    defaultRpc: 'https://rpc.mainnet.arc.io',
    alchemyPrefix: null,
    explorerUrl: 'https://explorer.arc.io',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  }
};

/**
 * Get chain by name (case insensitive)
 * @param {string} name 
 * @returns {object|null}
 */
function getChainByName(name) {
  const normalized = name.toUpperCase();
  return CHAINS[normalized] || null;
}

/**
 * Get chain by ID
 * @param {number} chainId 
 * @returns {object|null}
 */
function getChainById(chainId) {
  return Object.values(CHAINS).find(c => c.chainId === Number(chainId)) || null;
}

/**
 * Expand an Alchemy key to full RPC URL
 * @param {string} key 
 * @param {object} chain 
 * @returns {string}
 */
function expandAlchemyKey(key, chain) {
  if (!key || key.trim() === '') return chain.defaultRpc;
  if (key.startsWith('http')) return key;
  if (!chain || !chain.alchemyPrefix) return chain.defaultRpc || key;
  return `https://${chain.alchemyPrefix}.g.alchemy.com/v2/${key.trim()}`;
}

/**
 * Get choices for Inquirer prompts
 * @returns {Array<{name: string, value: object}>}
 */
function getChainChoices() {
  return Object.values(CHAINS).map(chain => ({
    name: `${chain.name} (Chain ID: ${chain.chainId})`,
    value: chain
  }));
}

/**
 * Get standardized uppercase chain key (e.g., 'ROBINHOOD', 'ETHEREUM', 'BASE')
 * @param {object|string|number} chain 
 * @returns {string}
 */
function getChainKey(chain) {
  if (!chain) return 'ETHEREUM';
  if (typeof chain === 'string') {
    const uc = chain.toUpperCase().trim();
    if (CHAINS[uc]) return uc;
    if (uc.includes('ROBINHOOD') && uc.includes('TESTNET')) return 'ROBINHOOD_TESTNET';
    if (uc.includes('ROBINHOOD')) return 'ROBINHOOD';
    if (uc.includes('ARC')) return 'ARC';
    if (uc.includes('BASE')) return 'BASE';
    if (uc.includes('ARBITRUM') || uc.includes('ARB')) return 'ARBITRUM';
    if (uc.includes('OPTIMISM') || uc.includes('OPT')) return 'OPTIMISM';
    if (uc.includes('SEPOLIA')) return 'SEPOLIA';
    return 'ETHEREUM';
  }

  const chainId = Number(chain.chainId);
  if (chainId) {
    for (const [key, config] of Object.entries(CHAINS)) {
      if (config.chainId === chainId) return key;
    }
  }

  if (chain.name) {
    return getChainKey(chain.name);
  }

  return 'ETHEREUM';
}

/**
 * Check if a chain is an L2 (Rollup / Orbit)
 * @param {object|string|number} chain 
 * @returns {boolean}
 */
function isLayer2Chain(chain) {
  if (!chain) return false;
  const key = getChainKey(chain);
  return ['ROBINHOOD', 'ROBINHOOD_TESTNET', 'BASE', 'ARBITRUM', 'OPTIMISM', 'ARC'].includes(key);
}

module.exports = {
  CHAINS,
  getChainByName,
  getChainById,
  getChainKey,
  expandAlchemyKey,
  getChainChoices,
  isLayer2Chain
};

