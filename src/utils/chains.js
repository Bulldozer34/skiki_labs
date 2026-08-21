/**
 * Chain Configurations (Prioritizing Ethereum Mainnet, Robinhood Mainnet & Robinhood Testnet)
 */

const CHAINS = {
  ROBINHOOD_TESTNET: {
    name: 'Robinhood Chain Testnet (Free $0 Faucet)',
    chainId: 46630,
    symbol: 'ETH',
    defaultRpc: 'https://rpc.testnet.chain.robinhood.com/rpc',
    alchemyPrefix: null,
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    faucetUrl: 'https://faucet.testnet.chain.robinhood.com',
    seadropAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
  },
  ROBINHOOD: {
    name: 'Robinhood Chain (Mainnet L2)',
    chainId: 4663,
    symbol: 'ETH',
    defaultRpc: 'https://rpc.mainnet.chain.robinhood.com',
    alchemyPrefix: null,
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
    defaultRpc: 'https://rpc.sepolia.org',
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

module.exports = {
  CHAINS,
  getChainByName,
  getChainById,
  expandAlchemyKey,
  getChainChoices
};
