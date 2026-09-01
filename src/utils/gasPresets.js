const logger = require('../utils/logger');

/**
 * Gas preset resolver.
 *
 * Extracted from cli.js so it can be reused by the Telegram daemon,
 * copy-mint engine, and any future entry point that needs gas settings
 * without going through the inquirer wizard.
 *
 * @param {string} preset  'ultra' | 'turbo' | 'custom'
 * @param {object} opts
 * @param {boolean} opts.isL2       Whether the target chain is an L2
 * @param {string|number} opts.liveBaseFeeGwei  Current base fee from the network
 * @param {object} [opts.custom]    Custom gas values when preset === 'custom'
 * @param {string} [opts.custom.maxFeePerGas]
 * @param {string} [opts.custom.maxPriorityFeePerGas]
 * @param {number} [opts.custom.gasLimit]
 * @returns {{ maxFeePerGas: string, maxPriorityFeePerGas: string, gasLimit: number, preset: string }}
 */
function resolveGasPreset(preset, { isL2, liveBaseFeeGwei, custom } = {}) {
  const baseFee = parseFloat(liveBaseFeeGwei) || (isL2 ? 0.1 : 20);
  const defaultGasLimit = isL2 ? 200000 : (parseInt(process.env.DEFAULT_GAS_LIMIT) || 300000);
  const normalizedPreset = (preset || 'turbo').toLowerCase();

  if (normalizedPreset === 'ultra' || normalizedPreset === 'hyped') {
    const maxFee = isL2
      ? (Math.max(1.0, baseFee * 3.0)).toFixed(2)
      : (Math.max(45.0, baseFee * 2.5)).toFixed(2);
    const tip = isL2 ? '0.35' : '4.5';

    if (logger && logger.speed) {
      logger.speed(`🔥 Ultra-Hyped Gas Armed: Max Fee ${maxFee} Gwei | Priority Tip ${tip} Gwei (Top Position)`);
    }

    return {
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
      gasLimit: defaultGasLimit,
      preset: 'ultra'
    };
  }

  if (normalizedPreset === 'turbo') {
    const maxFee = isL2
      ? (Math.max(0.4, baseFee * 1.5)).toFixed(2)
      : (Math.max(30.0, baseFee * 1.5)).toFixed(2);
    const tip = isL2 ? '0.1' : '2.0';

    return {
      maxFeePerGas: maxFee,
      maxPriorityFeePerGas: tip,
      gasLimit: defaultGasLimit,
      preset: 'turbo'
    };
  }

  // Custom / manual — use provided values or sensible defaults
  const calculatedMaxFee = (baseFee * 1.5).toFixed(3);
  const defaultMaxFee = isL2
    ? Math.max(0.2, Math.min(parseFloat(calculatedMaxFee) || 0.4, 1.0)).toString()
    : (process.env.DEFAULT_MAX_FEE_GWEI || '25.0');
  const defaultPriorityFee = isL2 ? '0.1' : (process.env.DEFAULT_PRIORITY_FEE_GWEI || '1.5');

  return {
    maxFeePerGas: custom?.maxFeePerGas || defaultMaxFee,
    maxPriorityFeePerGas: custom?.maxPriorityFeePerGas || defaultPriorityFee,
    gasLimit: custom?.gasLimit || defaultGasLimit,
    preset: 'custom'
  };
}

module.exports = { resolveGasPreset };
