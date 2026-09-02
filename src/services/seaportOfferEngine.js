const { ethers, Contract, Interface } = require('ethers');
const axios = require('axios');
const chalk = require('chalk');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNftsFromReceipt } = require('../engines/nftForwarder');

const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395'; // Seaport 1.6
const OPENSEA_CONDUIT = '0x1E0049783F008A0085193E00003D00cd54003c71'; // OpenSea Conduit
const OPENSEA_CONDUIT_KEY = '0x1e0049783f008a0085193e00003d00cd54003c71000000000000000000000000';

const ERC721_ABI = [
  'function setApprovalForAll(address operator, bool approved) external',
  'function isApprovedForAll(address owner, address operator) external view returns (bool)',
  'function ownerOf(uint256 tokenId) external view returns (address)'
];

const SEAPORT_ABI = [
  'function fulfillAdvancedOrder(tuple(tuple(address offerer, address zone, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address payable recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems) parameters, uint120 numerator, uint120 denominator, bytes signature, bytes extraData) advancedOrder, tuple(uint256 orderIndex, uint8 side, uint256 index, uint256 identifier, bytes32[] criteriaProof)[] criteriaResolvers, bytes32 fulfillerConduitKey, address recipient) external payable returns (bool fulfilled)'
];

/**
 * OpenSea & Seaport 1.6 Instant Flip & Offer Fulfillment Engine
 */
class SeaportOfferEngine {
  /**
   * Fetch top collection offer for an NFT contract or slug
   * @param {string} contractAddress 
   * @param {string} [slug] 
   * @param {string} [chain='robinhood'] 
   * @returns {Promise<object|null>}
   */
  static async getTopCollectionOffer(contractAddress, slug = '', chain = 'robinhood') {
    const apiKey = (process.env.OPENSEA_API_KEY || process.env.OPENSEA_API_KEY_2 || '').trim();
    const headers = { 'Accept': 'application/json' };
    if (apiKey) headers['x-api-key'] = apiKey;

    const urlsToTry = [];
    if (slug) {
      urlsToTry.push(`https://api.opensea.io/api/v2/offers/collection/${encodeURIComponent(slug)}`);
    }
    if (contractAddress) {
      urlsToTry.push(`https://api.opensea.io/api/v2/orders/${chain}/seaport/offers?asset_contract_address=${contractAddress}&order_by=eth_price&order_direction=desc&limit=1`);
    }

    for (const url of urlsToTry) {
      try {
        const res = await axios.get(url, { headers, timeout: 5000 });
        const orders = res.data?.offers || res.data?.orders || [];
        if (orders.length > 0) {
          const topOrder = orders[0];
          const rawPrice = topOrder.price?.current?.value || topOrder.current_price || '0';
          const decimals = topOrder.price?.current?.decimals || 18;
          const priceEth = ethers.formatUnits(rawPrice, decimals);

          return {
            orderHash: topOrder.order_hash,
            priceEth: parseFloat(priceEth),
            rawPrice,
            currency: topOrder.price?.current?.currency || 'WETH',
            protocolData: topOrder.protocol_data,
            orderParameters: topOrder.protocol_data?.parameters,
            signature: topOrder.protocol_data?.signature,
            rawData: topOrder
          };
        }
      } catch (err) {
        // Fall through to next query URL
      }
    }

    return null;
  }

  /**
   * Extract minted token items from mint results
   * @param {Array<object>} results 
   * @param {ethers.Wallet[]} wallets 
   * @returns {Array<{tokenId: string, contractAddress: string, wallet: ethers.Wallet, txHash: string}>}
   */
  static extractMintedTokens(results, wallets) {
    const erc721Iface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
    const tokens = [];

    for (const res of results) {
      if (res.status !== 'SUCCESS') continue;
      const receipt = res.receipt;
      if (!receipt || !receipt.logs) continue;

      const targetAddr = (res.address || res.walletAddress || '').toLowerCase();
      const wallet = wallets.find(w => w.address.toLowerCase() === targetAddr) || res.wallet;
      if (!wallet) continue;

      for (const log of receipt.logs) {
        try {
          const parsed = erc721Iface.parseLog(log);
          if (parsed && parsed.name === 'Transfer') {
            const to = (parsed.args.to || '').toLowerCase();
            if (to === wallet.address.toLowerCase()) {
              tokens.push({
                tokenId: parsed.args.tokenId.toString(),
                contractAddress: log.address,
                wallet,
                txHash: res.txHash,
                receipt
              });
            }
          }
        } catch (e) {}
      }
    }

    return tokens;
  }

  /**
   * Execute auto-sell / top offer fulfillment on Seaport 1.6
   * @param {object} params
   * @param {Array<object>} params.results Mint execution results
   * @param {ethers.Wallet[]} params.wallets
   * @param {ethers.Provider} params.provider
   * @param {string} params.nftContractAddress
   * @param {string} [params.collectionSlug]
   * @param {object} params.postMintConfig { action, scope, sellCount, minPriceEth, remainderAction, recipientAddress }
   * @param {string} [params.explorerUrl]
   */
  static async executeOfferFulfillment({
    results,
    wallets,
    provider,
    nftContractAddress,
    collectionSlug = '',
    postMintConfig = {},
    explorerUrl = ''
  }) {
    const mintedTokens = this.extractMintedTokens(results, wallets);
    if (mintedTokens.length === 0) {
      logger.warn('[Seaport Engine] No minted tokens detected in transaction receipts.');
      return;
    }

    logger.separator();
    logger.info(`💰 Seaport 1.6 Auto-Sell Engine activated for ${mintedTokens.length} minted NFT(s)`);
    logger.info(`Fetching highest active collection offer for ${nftContractAddress}...`);

    const topOffer = await this.getTopCollectionOffer(nftContractAddress, collectionSlug, 'robinhood');
    const minPriceEth = parseFloat(postMintConfig.minPriceEth || 0);

    if (!topOffer) {
      logger.warn('⚠️ No active collection offers found on Seaport/OpenSea for this contract right now.');
      if (postMintConfig.remainderAction === 'RECIPIENT' && postMintConfig.recipientAddress) {
        logger.info(`Auto-forwarding all ${mintedTokens.length} tokens to recipient: ${postMintConfig.recipientAddress}`);
        for (const token of mintedTokens) {
          const connectedWallet = token.wallet.connect ? token.wallet.connect(provider) : token.wallet;
          await forwardNftsFromReceipt({
            receipt: token.receipt,
            signer: connectedWallet,
            recipientAddress: postMintConfig.recipientAddress,
            provider,
            explorerUrl
          });
        }
      } else {
        logger.info('Tokens safely remain in minting wallets.');
      }
      return;
    }

    logger.speed(`Top Collection Offer Found: ${chalk.bold.green(topOffer.priceEth + ' ' + topOffer.currency)}`);

    // Safety Floor Check
    if (minPriceEth > 0 && topOffer.priceEth < minPriceEth) {
      logger.error(`🛡️ SAFETY FLOOR TRIGGERED: Top offer (${topOffer.priceEth} ETH) is below your minimum threshold (${minPriceEth} ETH)!`);
      logger.warn('Cancelling auto-sell to protect your asset from lowball bids.');

      if (postMintConfig.remainderAction === 'RECIPIENT' && postMintConfig.recipientAddress) {
        logger.info(`Forwarding tokens to recipient wallet: ${postMintConfig.recipientAddress}...`);
        for (const token of mintedTokens) {
          const connectedWallet = token.wallet.connect ? token.wallet.connect(provider) : token.wallet;
          await forwardNftsFromReceipt({
            receipt: token.receipt,
            signer: connectedWallet,
            recipientAddress: postMintConfig.recipientAddress,
            provider,
            explorerUrl
          });
        }
      }
      return;
    }

    // Determine which tokens to sell based on ALL vs SOME
    let tokensToSell = [];
    let remainingTokens = [];

    if (postMintConfig.scope === 'SOME') {
      const count = Math.max(1, Math.min(mintedTokens.length, parseInt(postMintConfig.sellCount) || 1));
      tokensToSell = mintedTokens.slice(0, count);
      remainingTokens = mintedTokens.slice(count);
      logger.info(`Splitting tokens: Selling ${tokensToSell.length} | Keeping/Forwarding ${remainingTokens.length}`);
    } else {
      tokensToSell = mintedTokens;
    }

    // Fulfill offers for selected tokens
    for (let i = 0; i < tokensToSell.length; i++) {
      const item = tokensToSell[i];
      const signer = item.wallet.connect ? item.wallet.connect(provider) : item.wallet;
      logger.info(`[${signer.address.slice(0, 6)}...] Processing instant flip for Token #${item.tokenId}...`);

      try {
        const nftContract = new Contract(item.contractAddress, ERC721_ABI, signer);

        // 1. Check Approval for Seaport Conduit
        const isApproved = await nftContract.isApprovedForAll(signer.address, OPENSEA_CONDUIT).catch(() => false);
        if (!isApproved) {
          logger.speed(`Approving OpenSea/Seaport Conduit (${OPENSEA_CONDUIT.slice(0, 6)}...) for Token #${item.tokenId}...`);
          const approveTx = await nftContract.setApprovalForAll(OPENSEA_CONDUIT, true, { gasLimit: 70000 });
          await approveTx.wait(1, 30000);
          logger.success('Seaport Conduit approved.');
        }

        // 2. Fulfill Advanced Order
        if (topOffer.orderParameters && topOffer.signature) {
          const seaportContract = new Contract(SEAPORT_ADDRESS, SEAPORT_ABI, signer);
          const criteriaResolvers = [
            {
              orderIndex: 0,
              side: 0, // Offer side
              index: 0,
              identifier: item.tokenId,
              criteriaProof: []
            }
          ];

          const advancedOrder = {
            parameters: topOffer.orderParameters,
            numerator: 1,
            denominator: 1,
            signature: topOffer.signature,
            extraData: '0x'
          };

          logger.speed(`Executing Seaport 1.6 fulfillAdvancedOrder for Token #${item.tokenId}...`);
          const fulfillTx = await seaportContract.fulfillAdvancedOrder(
            advancedOrder,
            criteriaResolvers,
            OPENSEA_CONDUIT_KEY,
            signer.address,
            { gasLimit: 250000 }
          );

          const receipt = await fulfillTx.wait(1, 45000);
          logger.success(`🎉 Token #${item.tokenId} SOLD to Top Offer for ${topOffer.priceEth} ${topOffer.currency}! (Block #${receipt.blockNumber})`);
          logger.speed(`Tx Hash: ${fulfillTx.hash}`);

          // Webhook notification
          Notifier.sendAlert(`💰 **NFT Instant Flip Successful!**\nToken #${item.tokenId} sold on Seaport for **${topOffer.priceEth} ${topOffer.currency}**!\nTx: ${fulfillTx.hash}`);
        } else {
          logger.warn(`Could not construct full Seaport order payload for Token #${item.tokenId}.`);
        }
      } catch (err) {
        logger.error(`Failed to fulfill top offer for Token #${item.tokenId}: ${err.message}`);
      }
    }

    // Handle remaining tokens if SOME was selected
    if (remainingTokens.length > 0 && postMintConfig.remainderAction === 'RECIPIENT' && postMintConfig.recipientAddress) {
      logger.info(`Forwarding remaining ${remainingTokens.length} token(s) to recipient: ${postMintConfig.recipientAddress}...`);
      for (const rem of remainingTokens) {
        const connectedWallet = rem.wallet.connect ? rem.wallet.connect(provider) : rem.wallet;
        await forwardNftsFromReceipt({
          receipt: rem.receipt,
          signer: connectedWallet,
          recipientAddress: postMintConfig.recipientAddress,
          provider,
          explorerUrl
        });
      }
    } else if (remainingTokens.length > 0) {
      logger.info(`Remaining ${remainingTokens.length} token(s) stay in minting wallets.`);
    }

    logger.success('Seaport offer fulfillment phase completed.');
  }
}

module.exports = SeaportOfferEngine;
