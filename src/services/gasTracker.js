const { ethers } = require('ethers');
const chalk = require('chalk');
const logger = require('../utils/logger');
const { getEthPriceUsd, convertEthToUsd } = require('../utils/priceFetcher');
const { isLayer2Chain } = require('../utils/chains');

/**
 * Live Gas Tracker & Network Traffic Gauge
 */
class GasTracker {
  /**
   * Fetch current gas metrics and calculate operation costs
   * @param {ethers.Provider} provider 
   * @param {object} [chainConfig] 
   * @returns {Promise<object>}
   */
  static async getGasMetrics(provider, chainConfig = {}) {
    const chainName = chainConfig.name || 'Robinhood Chain';
    const isL2 = isLayer2Chain(chainConfig) || (chainConfig.chainId === 4663 || chainConfig.chainId === 46630);

    const [feeData, latestBlock, ethPriceUsd] = await Promise.all([
      provider.getFeeData().catch(() => null),
      provider.getBlock('latest').catch(() => null),
      getEthPriceUsd().catch(() => 2500)
    ]);

    const baseFeeWei = latestBlock?.baseFeePerGas || feeData?.gasPrice || 1000000n;
    const baseFeeGwei = parseFloat(ethers.formatUnits(baseFeeWei, 'gwei'));

    const priorityFeeWei = feeData?.maxPriorityFeePerGas || (isL2 ? ethers.parseUnits('0.01', 'gwei') : ethers.parseUnits('1.0', 'gwei'));
    const priorityFeeGwei = parseFloat(ethers.formatUnits(priorityFeeWei, 'gwei'));

    const totalFeePerGasWei = baseFeeWei + priorityFeeWei;
    const totalFeeGwei = parseFloat(ethers.formatUnits(totalFeePerGasWei, 'gwei'));

    // Compute estimated costs for typical operations
    const transferGas = 21000n;
    const mintGas = 200000n;
    const seaportGas = 180000n;

    const transferCostEth = ethers.formatEther(totalFeePerGasWei * transferGas);
    const mintCostEth = ethers.formatEther(totalFeePerGasWei * mintGas);
    const seaportCostEth = ethers.formatEther(totalFeePerGasWei * seaportGas);

    const transferCostUsd = convertEthToUsd(transferCostEth, ethPriceUsd);
    const mintCostUsd = convertEthToUsd(mintCostEth, ethPriceUsd);
    const seaportCostUsd = convertEthToUsd(seaportCostEth, ethPriceUsd);

    // Traffic congestion assessment
    let statusLabel = '🟢 OPTIMAL';
    let statusColor = chalk.green;
    let trafficLevel = 'LOW';

    if (isL2) {
      if (baseFeeGwei > 0.5) {
        statusLabel = '🔴 SPIKING';
        statusColor = chalk.red.bold;
        trafficLevel = 'HIGH';
      } else if (baseFeeGwei > 0.05) {
        statusLabel = '🟡 NORMAL';
        statusColor = chalk.yellow;
        trafficLevel = 'MODERATE';
      }
    } else {
      if (baseFeeGwei > 25) {
        statusLabel = '🔴 SPIKING';
        statusColor = chalk.red.bold;
        trafficLevel = 'HIGH';
      } else if (baseFeeGwei > 5) {
        statusLabel = '🟡 NORMAL';
        statusColor = chalk.yellow;
        trafficLevel = 'MODERATE';
      }
    }

    return {
      chainName,
      chainId: chainConfig.chainId || 4663,
      isL2,
      blockNumber: latestBlock?.number || null,
      ethPriceUsd,
      baseFeeGwei,
      priorityFeeGwei,
      totalFeeGwei,
      trafficLevel,
      statusLabel,
      statusColor,
      estimates: {
        transfer: { gas: Number(transferGas), costEth: transferCostEth, costUsd: transferCostUsd },
        mint: { gas: Number(mintGas), costEth: mintCostEth, costUsd: mintCostUsd },
        seaport: { gas: Number(seaportGas), costEth: seaportCostEth, costUsd: seaportCostUsd }
      }
    };
  }

  /**
   * Render formatted terminal gas dashboard
   * @param {ethers.Provider} provider 
   * @param {object} [chainConfig] 
   */
  static async displayDashboard(provider, chainConfig = {}) {
    try {
      const metrics = await this.getGasMetrics(provider, chainConfig);

      console.log('\n' + chalk.bold.cyan('╔════════════════════════════════════════════════════════════════════════╗'));
      console.log(chalk.bold.cyan('║') + chalk.bold.yellow(' ⛽ REAL-TIME GAS TRACKER & NETWORK METRICS                            ') + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('╠════════════════════════════════════════════════════════════════════════╣'));
      console.log(chalk.bold.cyan('║') + ` Network:      ${chalk.bold.white(metrics.chainName)} (ID: ${metrics.chainId})`.padEnd(81) + chalk.bold.cyan('║'));
      if (metrics.blockNumber) {
        console.log(chalk.bold.cyan('║') + ` Latest Block: ${chalk.bold.white('#' + metrics.blockNumber)}`.padEnd(81) + chalk.bold.cyan('║'));
      }
      console.log(chalk.bold.cyan('║') + ` ETH Price:    ${chalk.bold.green('$' + metrics.ethPriceUsd.toLocaleString())}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + ` Traffic:      ${metrics.statusColor(metrics.statusLabel + ' (' + metrics.trafficLevel + ')')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('╟────────────────────────────────────────────────────────────────────────╢'));
      console.log(chalk.bold.cyan('║') + chalk.bold.white(' GAS PRICES (EIP-1559):                                                 ') + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • Base Fee:       ${chalk.cyan(metrics.baseFeeGwei.toFixed(4) + ' Gwei')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • Priority Tip:   ${chalk.cyan(metrics.priorityFeeGwei.toFixed(4) + ' Gwei')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • Total Effective:${chalk.bold.cyan(metrics.totalFeeGwei.toFixed(4) + ' Gwei')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('╟────────────────────────────────────────────────────────────────────────╢'));
      console.log(chalk.bold.cyan('║') + chalk.bold.white(' ESTIMATED TRANSACTION COSTS IN DOLLARS ($$):                          ') + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • NFT Mint Cost:  ${chalk.bold.green('$' + metrics.estimates.mint.costUsd + ' USD')} ${chalk.gray('(' + metrics.estimates.mint.costEth.slice(0, 10) + ' ETH)')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • ETH Transfer:   ${chalk.bold.green('$' + metrics.estimates.transfer.costUsd + ' USD')} ${chalk.gray('(' + metrics.estimates.transfer.costEth.slice(0, 10) + ' ETH)')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('║') + `   • Seaport Sell:   ${chalk.bold.green('$' + metrics.estimates.seaport.costUsd + ' USD')} ${chalk.gray('(' + metrics.estimates.seaport.costEth.slice(0, 10) + ' ETH)')}`.padEnd(81) + chalk.bold.cyan('║'));
      const costPer100kUsd = (parseFloat(metrics.estimates.transfer.costUsd) * (100000 / 21000)).toFixed(4);
      console.log(chalk.bold.cyan('║') + `   • Cost / 100k Gas:${chalk.bold.green('$' + costPer100kUsd + ' USD')}`.padEnd(81) + chalk.bold.cyan('║'));
      console.log(chalk.bold.cyan('╚════════════════════════════════════════════════════════════════════════╝\n'));

      return metrics;
    } catch (err) {
      logger.warn(`Could not render live gas dashboard: ${err.message}`);
      return null;
    }
  }
}

module.exports = GasTracker;
