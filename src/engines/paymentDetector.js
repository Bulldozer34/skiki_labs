/**
 * Payment Detector & Simulation Gate — Determines exact msg.value for copy-minting.
 *
 * Checks if a mint is Free (0 ETH) vs Paid, simulates with RPC `estimateGas`,
 * scales value if quantity differs, and protects against high-cost or drainer traps.
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');

class PaymentDetector {
  /**
   * Detect payment requirements and validate against safety limits.
   *
   * @param {object} params
   * @param {ethers.Provider} params.provider - RPC Provider
   * @param {string} params.contractAddress - Target contract
   * @param {string} params.calldata - Rewritten calldata
   * @param {string|bigint} params.sourceTxValue - Value from whale transaction
   * @param {string} params.executingWallet - Bot wallet address
   * @param {number} [params.quantity=1] - Quantity to mint
   * @param {number} [params.sourceQuantity=1] - Whale's minted quantity
   * @param {number} [params.maxMintEth=0.05] - Safety ceiling in ETH
   * @param {boolean} [params.skipSimulation=false] - Skip RPC simulation
   * @returns {Promise<object>} Payment plan with { shouldExecute, selectedValue, paymentMode, reason }
   */
  static async detect(params) {
    const {
      provider,
      contractAddress,
      calldata,
      sourceTxValue = '0',
      executingWallet,
      quantity = 1,
      sourceQuantity = 1,
      maxMintEth = 0.05,
      skipSimulation = false
    } = params;

    const sourceValueBig = BigInt(sourceTxValue || '0');
    const srcQty = Math.max(1, sourceQuantity);
    const targetQty = Math.max(1, quantity);

    // Calculate unit price from source
    const valuePerToken = sourceValueBig / BigInt(srcQty);
    const scaledValue = valuePerToken * BigInt(targetQty);

    // Check against maxMintEth
    const scaledEth = parseFloat(ethers.formatEther(scaledValue));
    if (scaledEth > maxMintEth) {
      return {
        shouldExecute: false,
        paymentMode: 'rejected',
        selectedValue: '0',
        selectedValueEth: '0',
        valuePerToken,
        quantity: targetQty,
        confidence: 'high',
        reason: `Exceeds max allowed price (${scaledEth} ETH > ${maxMintEth} ETH limit)`
      };
    }

    if (skipSimulation) {
      return {
        shouldExecute: true,
        paymentMode: scaledValue === 0n ? 'free' : 'paid',
        selectedValue: '0x' + scaledValue.toString(16),
        selectedValueEth: ethers.formatEther(scaledValue),
        valuePerToken,
        quantity: targetQty,
        confidence: 'medium',
        reason: 'Blind broadcast / simulation skipped'
      };
    }

    // RPC Simulation helper
    async function simulateValue(val) {
      try {
        await provider.estimateGas({
          to: contractAddress,
          data: calldata,
          value: val > 0n ? '0x' + val.toString(16) : '0x0',
          from: executingWallet
        });
        return { success: true };
      } catch (err) {
        return { success: false, error: err.reason || err.message || 'reverted' };
      }
    }

    // 1. If source was 0 ETH, test free path first
    if (sourceValueBig === 0n) {
      const freeSim = await simulateValue(0n);
      if (freeSim.success) {
        return {
          shouldExecute: true,
          paymentMode: 'free',
          selectedValue: '0x0',
          selectedValueEth: '0',
          valuePerToken: 0n,
          quantity: targetQty,
          confidence: 'high',
          reason: 'Source tx was 0 ETH and simulation confirmed free mint'
        };
      }
    }

    // 2. Test scaled value path
    const scaledSim = await simulateValue(scaledValue);
    if (scaledSim.success) {
      return {
        shouldExecute: true,
        paymentMode: scaledValue === 0n ? 'free' : 'paid',
        selectedValue: '0x' + scaledValue.toString(16),
        selectedValueEth: ethers.formatEther(scaledValue),
        valuePerToken,
        quantity: targetQty,
        confidence: 'high',
        reason: `Simulation passed with value ${ethers.formatEther(scaledValue)} ETH`
      };
    }

    // 3. If scaled value failed but source was paid, try exact source value
    if (scaledValue !== sourceValueBig && sourceValueBig > 0n) {
      const srcSim = await simulateValue(sourceValueBig);
      if (srcSim.success) {
        return {
          shouldExecute: true,
          paymentMode: 'paid',
          selectedValue: '0x' + sourceValueBig.toString(16),
          selectedValueEth: ethers.formatEther(sourceValueBig),
          valuePerToken: sourceValueBig,
          quantity: 1,
          confidence: 'medium',
          reason: `Simulation passed with exact whale value ${ethers.formatEther(sourceValueBig)} ETH`
        };
      }
    }

    // 4. Try free path (0 ETH) in case contract only takes zero
    if (scaledValue > 0n) {
      const freeSim = await simulateValue(0n);
      if (freeSim.success) {
        return {
          shouldExecute: true,
          paymentMode: 'free',
          selectedValue: '0x0',
          selectedValueEth: '0',
          valuePerToken: 0n,
          quantity: targetQty,
          confidence: 'medium',
          reason: 'Paid simulation reverted but free (0 ETH) simulation succeeded'
        };
      }
    }

    // Reverted on all paths
    return {
      shouldExecute: false,
      paymentMode: 'rejected',
      selectedValue: '0x0',
      selectedValueEth: '0',
      valuePerToken: 0n,
      quantity: targetQty,
      confidence: 'low',
      reason: `Simulation reverted: ${scaledSim.error || 'Contract rejected call'}`
    };
  }
}

module.exports = PaymentDetector;
