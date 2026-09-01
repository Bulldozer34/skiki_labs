/**
 * Profit & ROI Calculator
 * Calculates realized and unrealized PnL, ROI multiples, and win-rates for low-cost/free mints.
 */

const ethers = require('ethers');

class ProfitCalculator {
  constructor(options = {}) {
    this.maxMintCostUSD = options.maxMintCostUSD || 0.50;
    this.ethPriceUSD = options.ethPriceUSD || 2600; // Estimated baseline ETH price
  }

  /**
   * Convert ETH/WEI to USD
   */
  ethToUSD(weiAmount) {
    if (!weiAmount) return 0;
    const eth = parseFloat(ethers.formatEther(weiAmount));
    return eth * this.ethPriceUSD;
  }

  /**
   * Convert USDG (6 decimals) or Token to USD
   */
  usdgToUSD(rawAmount) {
    if (!rawAmount) return 0;
    return parseFloat(rawAmount) / 1e6;
  }

  /**
   * Calculate wallet performance summary
   */
  computeWalletPnL(mints, sales, floorPrices = {}) {
    let totalMintCostUSD = 0;
    let validMintsCount = 0;
    let qualifyingDrops = new Set();
    let profitableDrops = new Set();
    let totalRealizedRevenueUSD = 0;
    let totalSoldTokens = 0;

    // Group mints by contract
    const mintsByContract = {};
    for (const m of mints) {
      const contract = m.nftContract.toLowerCase();
      const unitPriceEth = parseFloat(ethers.formatEther(m.unitMintPrice || 0));
      const unitPriceUSD = unitPriceEth * this.ethPriceUSD;

      // Filter: only consider mints <= maxMintCostUSD ($0.50)
      if (unitPriceUSD > this.maxMintCostUSD) {
        continue;
      }

      validMintsCount += m.quantity;
      const totalCostUSD = unitPriceUSD * m.quantity;
      totalMintCostUSD += totalCostUSD;
      qualifyingDrops.add(contract);

      if (!mintsByContract[contract]) {
        mintsByContract[contract] = {
          contract,
          quantity: 0,
          costUSD: 0,
          txHashes: []
        };
      }
      mintsByContract[contract].quantity += m.quantity;
      mintsByContract[contract].costUSD += totalCostUSD;
      mintsByContract[contract].txHashes.push(m.txHash);
    }

    if (validMintsCount === 0) {
      return null;
    }

    // Process secondary sales by this wallet for minted collections
    const salesByContract = {};
    for (const s of sales) {
      const contract = s.tokenContract.toLowerCase();
      if (!qualifyingDrops.has(contract)) continue;

      let saleUSD = 0;
      if (s.currencyType === 'ETH' || s.currencyType === '0') {
        saleUSD = this.ethToUSD(s.priceWei);
      } else if (s.currencyType === 'USDG' || s.currencyType === '1') {
        saleUSD = this.usdgToUSD(s.priceWei);
      } else {
        saleUSD = this.ethToUSD(s.priceWei);
      }

      totalRealizedRevenueUSD += saleUSD;
      totalSoldTokens += s.quantity || 1;

      if (!salesByContract[contract]) {
        salesByContract[contract] = {
          revenueUSD: 0,
          salesCount: 0
        };
      }
      salesByContract[contract].revenueUSD += saleUSD;
      salesByContract[contract].salesCount += (s.quantity || 1);
    }

    // Estimate unrealized value from floor prices for remaining tokens
    let unrealizedFloorValueUSD = 0;
    for (const contract of qualifyingDrops) {
      const minted = mintsByContract[contract].quantity;
      const sold = (salesByContract[contract] ? salesByContract[contract].salesCount : 0);
      const held = Math.max(0, minted - sold);
      const floorUSD = floorPrices[contract] || 0;

      const unrealizedUSD = held * floorUSD;
      unrealizedFloorValueUSD += unrealizedUSD;

      const contractRevenue = (salesByContract[contract] ? salesByContract[contract].revenueUSD : 0);
      const contractTotalValue = contractRevenue + unrealizedUSD;
      const contractCost = mintsByContract[contract].costUSD;

      if (contractTotalValue > contractCost + 0.10) { // minimum profit threshold ($0.10+ profit)
        profitableDrops.add(contract);
      }
    }

    const netRealizedProfitUSD = totalRealizedRevenueUSD - totalMintCostUSD;
    const totalValueUSD = totalRealizedRevenueUSD + unrealizedFloorValueUSD;
    const netTotalProfitUSD = totalValueUSD - totalMintCostUSD;

    const roiMultiplier = totalMintCostUSD > 0 
      ? (totalValueUSD / totalMintCostUSD)
      : (totalValueUSD > 0 ? 999.0 : 1.0); // Infinite ROI on pure free mints

    const winRate = qualifyingDrops.size > 0 
      ? (profitableDrops.size / qualifyingDrops.size) * 100 
      : 0;

    return {
      distinctDropsCount: qualifyingDrops.size,
      profitableDropsCount: profitableDrops.size,
      totalMintCount: validMintsCount,
      totalMintCostUSD: parseFloat(totalMintCostUSD.toFixed(2)),
      totalRealizedRevenueUSD: parseFloat(totalRealizedRevenueUSD.toFixed(2)),
      netRealizedProfitUSD: parseFloat(netRealizedProfitUSD.toFixed(2)),
      unrealizedFloorValueUSD: parseFloat(unrealizedFloorValueUSD.toFixed(2)),
      netTotalProfitUSD: parseFloat(netTotalProfitUSD.toFixed(2)),
      roiMultiplier: parseFloat(roiMultiplier.toFixed(2)),
      winRatePercent: parseFloat(winRate.toFixed(1)),
      qualifyingDrops: Array.from(qualifyingDrops),
      profitableDrops: Array.from(profitableDrops)
    };
  }
}

module.exports = ProfitCalculator;
