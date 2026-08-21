const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Collection & Drop Service
 */
const CollectionService = {
  /**
   * Get Drop Info via OpenSea GraphQL API
   * @param {string} slug 
   * @param {object} authHeaders 
   * @returns {Promise<object|null>}
   */
  async getDropInfo(slug, authHeaders) {
    try {
      const cleanSlug = typeof slug === 'string' ? slug.trim() : '';
      if (!cleanSlug) return null;

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

      const res = await axios.post('https://gql.opensea.io/graphql/', {
        query,
        variables
      }, {
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      if (res.data && res.data.data && res.data.data.dropBySlug) {
        return res.data.data.dropBySlug;
      }
      return null;
    } catch (error) {
      logger.error(`Error fetching drop info for slug "${slug}": ${error.message}`);
      return null;
    }
  },

  /**
   * Fallback to resolve contract from slug using public V2 API (unauthenticated & URI encoded)
   * @param {string} slug 
   * @returns {Promise<string|null>}
   */
  async getContractFromSlug(slug) {
    try {
      if (!slug || typeof slug !== 'string') return null;
      const safeSlug = encodeURIComponent(slug.trim());
      const res = await axios.get(`https://api.opensea.io/api/v2/collections/${safeSlug}`, {
        timeout: 5000
      });
      if (res.data && res.data.contracts && res.data.contracts.length > 0) {
        return res.data.contracts[0].address;
      }
      return null;
    } catch (error) {
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
        const start = new Date(stage.startTime).toLocaleString();
        const end = stage.endTime ? new Date(stage.endTime).toLocaleString() : 'TBD';
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
