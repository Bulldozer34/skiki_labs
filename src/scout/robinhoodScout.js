/**
 * Robinhood NFT Alpha Scout Engine
 * Discovers and profiles profitable low-cost/free NFT copy-mint wallets on Robinhood Chain (4663).
 */

const ethers = require('ethers');
const axios = require('axios');
const ScamFilter = require('./scamFilter');
const ProfitCalculator = require('./profitCalculator');
const connectionManager = require('../services/connectionManager');

const SEADROP_ADDRESS = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
const SEAPORT_ADDRESS = '0x0000000000000068F116a894984e2DB1123eB395';

const SEADROP_ABI = [
  'event SeaDropMint(address indexed nftContract, address indexed minter, address indexed feeRecipient, address payer, uint256 quantityMinted, uint256 unitMintPrice, uint256 feeBps, uint256 dropStageIndex)'
];

const SEAPORT_ABI = [
  'event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)'
];

class RobinhoodScout {
  constructor(options = {}) {
    this.rpcUrl = options.rpcUrl || 'https://rpc.mainnet.chain.robinhood.com';
    this.provider = connectionManager.createEthersProvider(this.rpcUrl, 4663);
    this.apiKey = options.apiKey || process.env.OPENSEA_API_KEY || '';
    this.maxMintCostUSD = options.maxMintCostUSD || 0.50;
    this.minDistinctDrops = options.minDistinctDrops || 2;
    this.scamFilter = new ScamFilter({ minDistinctDrops: this.minDistinctDrops });
    this.profitCalc = new ProfitCalculator({ maxMintCostUSD: this.maxMintCostUSD });
    this.floorPrices = {};
    this.collectionMetadata = {};
  }

  /**
   * Fetch all Robinhood collections and floor prices from OpenSea API
   */
  async loadOpenSeaCollections() {
    console.log('[Scout] Fetching OpenSea Robinhood collections & floor prices...');
    let next = '';
    let fetched = 0;

    try {
      do {
        const url = `https://api.opensea.io/api/v2/collections?chain=robinhood&limit=100` + (next ? `&next=${next}` : '');
        const res = await axios.get(url, {
          headers: this.apiKey ? { 'x-api-key': this.apiKey } : {},
          timeout: 10000
        });

        const collections = res.data.collections || [];
        for (const col of collections) {
          if (col.contracts && col.contracts.length > 0) {
            for (const c of col.contracts) {
              const contractAddr = c.address.toLowerCase();
              this.collectionMetadata[contractAddr] = {
                name: col.name,
                slug: col.collection,
                description: col.description || '',
                imageUrl: col.image_url || ''
              };
              if (col.owner) {
                this.scamFilter.registerDeployer(col.owner);
              }
            }
          }
        }
        fetched += collections.length;
        next = res.data.next || '';
      } while (next && fetched < 300);

      console.log(`[Scout] Indexed ${fetched} OpenSea collections.`);
    } catch (err) {
      console.warn(`[Scout] Warning fetching OpenSea collections: ${err.message}`);
    }
  }

  /**
   * Scan SeaDrop mint events in block intervals
   */
  async scanSeaDropMints(fromBlock, toBlock, step = 2000) {
    console.log(`[Scout] Scanning SeaDrop mint logs from block ${fromBlock} to ${toBlock} (step: ${step})...`);
    const seadropIface = new ethers.Interface(SEADROP_ABI);
    const topic0 = seadropIface.getEvent('SeaDropMint').topicHash;
    const allMints = [];

    for (let current = fromBlock; current <= toBlock; current += step) {
      const end = Math.min(current + step - 1, toBlock);
      try {
        const logs = await this.provider.getLogs({
          address: SEADROP_ADDRESS,
          topics: [topic0],
          fromBlock: current,
          toBlock: end
        });

        for (const log of logs) {
          try {
            const parsed = seadropIface.parseLog(log);
            const feeRecipient = parsed.args.feeRecipient;
            if (feeRecipient) {
              this.scamFilter.registerDeployer(feeRecipient);
            }

            allMints.push({
              nftContract: parsed.args.nftContract.toLowerCase(),
              minter: parsed.args.minter.toLowerCase(),
              payer: parsed.args.payer.toLowerCase(),
              quantity: Number(parsed.args.quantityMinted),
              unitMintPrice: parsed.args.unitMintPrice,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash
            });
          } catch (e) {
            // Skip unparseable log
          }
        }
      } catch (err) {
        console.warn(`[Scout] Range [${current}..${end}] failed: ${err.message}`);
      }
    }

    console.log(`[Scout] Collected ${allMints.length} SeaDrop mint events.`);
    return allMints;
  }

  /**
   * Scan Seaport secondary sales in block intervals
   */
  async scanSeaportSales(fromBlock, toBlock, step = 2000) {
    console.log(`[Scout] Scanning Seaport 1.6 secondary sales from block ${fromBlock} to ${toBlock}...`);
    const seaportIface = new ethers.Interface(SEAPORT_ABI);
    const topic0 = seaportIface.getEvent('OrderFulfilled').topicHash;
    const allSales = [];

    for (let current = fromBlock; current <= toBlock; current += step) {
      const end = Math.min(current + step - 1, toBlock);
      try {
        const logs = await this.provider.getLogs({
          address: SEAPORT_ADDRESS,
          topics: [topic0],
          fromBlock: current,
          toBlock: end
        });

        for (const log of logs) {
          try {
            const parsed = seaportIface.parseLog(log);
            const offerer = parsed.args.offerer.toLowerCase();
            const recipient = parsed.args.recipient.toLowerCase();

            // Check what was offered and what was received
            for (const offerItem of parsed.args.offer) {
              // itemType 2 = ERC721, itemType 3 = ERC1155
              if (offerItem.itemType === 2n || offerItem.itemType === 3n || offerItem.itemType === 2 || offerItem.itemType === 3) {
                const tokenContract = offerItem.token.toLowerCase();
                const tokenId = offerItem.identifier.toString();
                const quantity = Number(offerItem.amount || 1);

                // Calculate price from consideration items
                let priceWei = 0n;
                let currencyType = 'ETH';
                for (const cons of parsed.args.consideration) {
                  if (cons.recipient.toLowerCase() === offerer) {
                    priceWei += BigInt(cons.amount.toString());
                    if (cons.itemType === 1n || cons.itemType === 1) {
                      currencyType = 'USDG'; // ERC-20 payment
                    }
                  }
                }

                if (!this.scamFilter.isWashTrade(offerer, recipient)) {
                  allSales.push({
                    seller: offerer,
                    buyer: recipient,
                    tokenContract,
                    tokenId,
                    quantity,
                    priceWei: priceWei.toString(),
                    currencyType,
                    blockNumber: log.blockNumber,
                    txHash: log.transactionHash
                  });

                  // Update floor price heuristic if valid sale
                  const saleUSD = currencyType === 'USDG'
                    ? this.profitCalc.usdgToUSD(priceWei.toString())
                    : this.profitCalc.ethToUSD(priceWei.toString());
                  if (saleUSD > 0) {
                    if (!this.floorPrices[tokenContract] || saleUSD < this.floorPrices[tokenContract]) {
                      this.floorPrices[tokenContract] = saleUSD;
                    }
                  }
                }
              }
            }
          } catch (e) {
            // Skip unparseable log
          }
        }
      } catch (err) {
        console.warn(`[Scout] Sales range [${current}..${end}] failed: ${err.message}`);
      }
    }

    console.log(`[Scout] Collected ${allSales.length} validated secondary sales.`);
    return allSales;
  }

  /**
   * Run the full scout analysis pipeline
   */
  async runAnalysis(blockLookback = 40000) {
    const latestBlock = await this.provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - blockLookback);

    console.log(`[Scout] Starting discovery on Robinhood Chain from block ${fromBlock} to ${latestBlock} (${blockLookback} blocks)...`);

    await this.loadOpenSeaCollections();
    const mints = await this.scanSeaDropMints(fromBlock, latestBlock, 2500);
    const sales = await this.scanSeaportSales(fromBlock, latestBlock, 2500);

    // Group mints & sales by wallet
    const walletMints = {};
    for (const m of mints) {
      if (!walletMints[m.minter]) walletMints[m.minter] = [];
      walletMints[m.minter].push(m);
    }

    const walletSales = {};
    for (const s of sales) {
      if (!walletSales[s.seller]) walletSales[s.seller] = [];
      walletSales[s.seller].push(s);
    }

    // Process and evaluate each wallet
    const evaluatedWallets = [];

    for (const [address, minterMints] of Object.entries(walletMints)) {
      const minterSales = walletSales[address] || [];
      const pnl = this.profitCalc.computeWalletPnL(minterMints, minterSales, this.floorPrices);

      if (!pnl) continue;

      const walletData = {
        address,
        distinctDropsCount: pnl.distinctDropsCount,
        isInsiderSuspect: false
      };

      const safety = this.scamFilter.evaluateWallet(walletData);
      if (!safety.safe) {
        continue; // Exclude suspicious or single-drop wallets
      }

      // Calculate an overall Alpha Score:
      // Weighting: Win Rate (40%), Total Profit (35%), Multiplier (15%), Distinct Drops (10%)
      const alphaScore = (
        (pnl.winRatePercent * 0.40) +
        (Math.min(pnl.netTotalProfitUSD * 2, 50)) +
        (Math.min(pnl.roiMultiplier * 2, 30)) +
        (pnl.distinctDropsCount * 5)
      );

      evaluatedWallets.push({
        address,
        alphaScore: parseFloat(alphaScore.toFixed(2)),
        ...pnl,
        contractDetails: pnl.qualifyingDrops.map(addr => ({
          contract: addr,
          name: (this.collectionMetadata[addr] && this.collectionMetadata[addr].name) || 'Unknown Collection',
          slug: (this.collectionMetadata[addr] && this.collectionMetadata[addr].slug) || ''
        }))
      });
    }

    // Sort by Alpha Score descending
    evaluatedWallets.sort((a, b) => b.alphaScore - a.alphaScore);

    console.log(`[Scout] Discovery complete. Found ${evaluatedWallets.length} verified top copy-minting wallets.`);
    return evaluatedWallets;
  }
}

module.exports = RobinhoodScout;
