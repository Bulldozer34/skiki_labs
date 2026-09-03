const axios = require('axios');
const { ethers } = require('ethers');
const { CHAINS } = require('../utils/chains');
const { SEADROP_ADDRESSES, getPublicDropParams } = require('../contracts/seadrop');
const connectionManager = require('./connectionManager');
const logger = require('../utils/logger');

/**
 * Collection & Drop Service
 */
const CollectionService = {
  /**
   * Fetch complete collection metadata via OpenSea v2 REST API
   * @param {string} slug
   * @returns {Promise<{address: string, chain: string, name: string, slug: string, imageUrl: string, description: string}|null>}
   */
  async getCollectionDetails(slug) {
    try {
      if (!slug || typeof slug !== 'string') return null;
      const safeSlug = encodeURIComponent(slug.trim());
      const apiKey = (process.env.OPENSEA_API_KEY || process.env.OPENSEA_KEY || '').trim();

      const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {})
      };

      const client = connectionManager?.axiosInstance || axios;
      const res = await client.get(`https://api.opensea.io/api/v2/collections/${safeSlug}`, {
        headers,
        timeout: 6000
      });

      if (res.data && res.data.contracts && res.data.contracts.length > 0) {
        return {
          address: res.data.contracts[0].address,
          chain: res.data.contracts[0].chain || 'ethereum',
          name: res.data.name || slug,
          slug: res.data.collection || slug,
          imageUrl: res.data.image_url || '',
          description: res.data.description || ''
        };
      }
      return null;
    } catch (error) {
      logger.warn(`[CollectionService] Could not resolve collection "${slug}" via OpenSea v2 API: ${error.message}`);
      return null;
    }
  },

  /**
   * Fallback to resolve contract from slug using public V2 API (unauthenticated & URI encoded)
   * @param {string} slug 
   * @returns {Promise<string|null>}
   */
  async getContractFromSlug(slug) {
    const details = await this.getCollectionDetails(slug);
    return details?.address || null;
  },

  /**
   * Get Drop Info via OpenSea GraphQL API with automatic on-chain SeaDrop fallback
   * @param {string} slug 
   * @param {object} authHeaders 
   * @returns {Promise<object|null>}
   */
  async getDropInfo(slug, authHeaders = {}) {
    const cleanSlug = typeof slug === 'string' ? slug.trim() : '';
    if (!cleanSlug) return null;

    // 1. Try OpenSea GraphQL API
    try {
      const query = `
        query CollectionDropQuery($slug: String!) {
          dropBySlug(slug: $slug) {
            name
            description  
            chainIdentifier
            nftContractAddress
            imageUrl
            stages {
              name
              startTime
              endTime
              mintPrice { unit symbol }
              maxMintsPerWallet
              stageIndex
              mintedCount
              maxSupply
            }
          }
        }
      `;

      const variables = { slug: cleanSlug };
      const gqlHeaders = {
        ...authHeaders,
        'Content-Type': 'application/json',
        'x-app-id': process.env.X_APP_ID || 'os2-web'
      };

      const apiKey = (process.env.OPENSEA_API_KEY || process.env.OPENSEA_KEY || '').trim();
      if (apiKey) {
        gqlHeaders['x-api-key'] = apiKey;
      }

      const gqlUrl = process.env.OPENSEA_GQL_URL || 'https://gql.opensea.io/graphql/';
      const client = connectionManager?.axiosInstance || axios;
      const res = await client.post(gqlUrl, {
        query,
        variables
      }, {
        headers: gqlHeaders,
        timeout: 6000
      });

      if (res.data && res.data.data && res.data.data.dropBySlug && res.data.data.dropBySlug.stages) {
        return res.data.data.dropBySlug;
      }
    } catch (gqlErr) {
      logger.warn(`[CollectionService] OpenSea GQL failed for "${cleanSlug}", falling back to REST + on-chain lookup...`);
    }

    // 2. Resilient Fallback: Resolve via OpenSea v2 REST + Query On-Chain SeaDrop Contract
    try {
      const details = await this.getCollectionDetails(cleanSlug);
      if (!details || !details.address) {
        return null;
      }

      const chainKey = (details.chain || 'robinhood').toUpperCase();
      const chainConfig = CHAINS[chainKey] || CHAINS.ROBINHOOD;
      const seadropAddress = SEADROP_ADDRESSES[chainKey] || SEADROP_ADDRESSES.ROBINHOOD;

      const rpcUrl = chainConfig.defaultRpc || 'https://rpc.mainnet.chain.robinhood.com';
      const provider = connectionManager?.createEthersProvider
        ? connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId)
        : new ethers.JsonRpcProvider(rpcUrl);

      const dropParams = await getPublicDropParams(provider, seadropAddress, details.address).catch(() => null);

      const stages = [];
      if (dropParams && dropParams.startTime > 0n) {
        const startSec = Number(dropParams.startTime);
        const endSec = Number(dropParams.endTime);
        const priceEth = ethers.formatEther(dropParams.mintPrice);
        const maxMints = Number(dropParams.maxMintable);

        stages.push({
          name: 'Public Mint (SeaDrop)',
          startTime: startSec,
          endTime: endSec,
          mintPrice: { unit: priceEth, symbol: 'ETH' },
          maxMintsPerWallet: maxMints,
          stageIndex: 0,
          mintedCount: 0,
          maxSupply: 0
        });
      }

      return {
        name: details.name,
        description: details.description,
        chainIdentifier: chainKey,
        nftContractAddress: details.address,
        imageUrl: details.imageUrl,
        stages
      };
    } catch (fallbackErr) {
      logger.error(`[CollectionService] Fallback drop resolution failed for "${cleanSlug}": ${fallbackErr.message}`);
      return null;
    }
  },

  /**
   * Display Drop Info to console using logger
   * @param {object} dropInfo 
   */
  displayDropInfo(dropInfo) {
    if (!dropInfo) {
      logger.error('No drop info available to display.');
      return;
    }

    logger.separator();
    logger.info(`Drop: ${dropInfo.name}`);
    logger.info(`Chain: ${dropInfo.chainIdentifier}`);
    logger.info(`Contract: ${dropInfo.nftContractAddress}`);
    logger.separator();

    if (dropInfo.stages && dropInfo.stages.length > 0) {
      dropInfo.stages.forEach(stage => {
        const start = stage.startTime ? new Date(Number(stage.startTime) > 1e11 ? Number(stage.startTime) : Number(stage.startTime) * 1000).toLocaleString() : 'TBD';
        const end = stage.endTime ? new Date(Number(stage.endTime) > 1e11 ? Number(stage.endTime) : Number(stage.endTime) * 1000).toLocaleString() : 'TBD';
        const price = stage.mintPrice ? `${stage.mintPrice.unit} ${stage.mintPrice.symbol}` : 'Free';
        const max = stage.maxMintsPerWallet || 'Unlimited';
        
        console.log(`- Stage: ${stage.name}`);
        console.log(`  Starts: ${start} | Ends: ${end}`);
        console.log(`  Price: ${price} | Max/Wallet: ${max}`);
        console.log(`  Minted: ${stage.mintedCount || 0} / ${stage.maxSupply || '∞'}`);
      });
    } else {
      logger.warn('No mint stages found in drop data.');
    }
    logger.separator();
  }
};

module.exports = CollectionService;
