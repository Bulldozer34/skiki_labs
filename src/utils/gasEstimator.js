const { ethers } = require('ethers');

/**
 * @typedef {Object} GasEstimate
 * @property {bigint} maxFeePerGas - Maximum total fee per gas in wei
 * @property {bigint} maxPriorityFeePerGas - Priority tip per gas in wei
 * @property {bigint} baseFee - Base fee from the latest block in wei
 * @property {string} estimatedGwei - Max fee per gas formatted in Gwei
 */

/**
 * Fallback gas settings in case RPC querying fails
 */
const DEFAULT_FALLBACK = {
  maxFeePerGas: ethers.parseUnits('30', 'gwei'),
  maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
  baseFee: ethers.parseUnits('14', 'gwei'),
  estimatedGwei: '30.0'
};

/**
 * Estimates dynamic gas fees using eth_feeHistory from the provider.
 *
 * @param {import('ethers').Provider} provider - The ethers provider instance
 * @param {'standard'|'fast'|'turbo'} [speedPreset='fast'] - Speed preset for priority tip
 * @returns {Promise<GasEstimate>} Estimated gas parameters with maxFeePerGas and maxPriorityFeePerGas
 */
async function estimateGas(provider, speedPreset = 'fast') {
  try {
    if (!provider || typeof provider.send !== 'function') {
      return { ...DEFAULT_FALLBACK };
    }

    // Query fee history for the last 5 blocks with 25th, 50th, and 75th percentiles
    const feeHistory = await provider.send('eth_feeHistory', ['0x5', 'latest', [25, 50, 75]]);

    if (!feeHistory || !Array.isArray(feeHistory.baseFeePerGas) || feeHistory.baseFeePerGas.length === 0) {
      return { ...DEFAULT_FALLBACK };
    }

    // Latest base fee (last element of baseFeePerGas array)
    const baseFee = BigInt(feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1]);

    // Determine percentile index based on speed preset
    const preset = (speedPreset || 'fast').toLowerCase();
    let percentileIndex = 1; // default 'fast' (50th percentile)

    if (preset === 'standard') {
      percentileIndex = 0; // 25th percentile
    } else if (preset === 'turbo') {
      percentileIndex = 2; // 75th percentile
    } else {
      percentileIndex = 1; // 50th percentile ('fast')
    }

    // Calculate average priority fee across available historical blocks
    let priorityFee = 0n;
    if (Array.isArray(feeHistory.reward) && feeHistory.reward.length > 0) {
      const rewards = feeHistory.reward
        .map(blockRewards => {
          if (Array.isArray(blockRewards) && blockRewards[percentileIndex] != null) {
            return BigInt(blockRewards[percentileIndex]);
          }
          return null;
        })
        .filter(reward => reward !== null);

      if (rewards.length > 0) {
        const sum = rewards.reduce((acc, val) => acc + val, 0n);
        priorityFee = sum / BigInt(rewards.length);
      }
    }

    // Apply 20% buffer for turbo preset
    if (preset === 'turbo') {
      priorityFee = (priorityFee * 120n) / 100n;
    }

    // Calculate maxFeePerGas with 2x baseFee safety buffer + priority tip
    const maxPriorityFeePerGas = priorityFee;
    const maxFeePerGas = (baseFee * 2n) + maxPriorityFeePerGas;
    const estimatedGwei = ethers.formatUnits(maxFeePerGas, 'gwei');

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      baseFee,
      estimatedGwei
    };
  } catch (error) {
    return { ...DEFAULT_FALLBACK };
  }
}

/**
 * Formats a gas estimate object into a human-readable string.
 *
 * @param {Partial<GasEstimate>} estimate - The gas estimate object
 * @returns {string} Human-readable gas estimate string (e.g., "Base: 12.5 gwei | Priority: 1.2 gwei | Max: 26.2 gwei")
 */
function formatGasEstimate(estimate) {
  if (!estimate) {
    return 'Base: 0 gwei | Priority: 0 gwei | Max: 0 gwei';
  }

  const formatGweiValue = (val) => {
    if (val === undefined || val === null) return '0';
    try {
      const gweiStr = typeof val === 'bigint'
        ? ethers.formatUnits(val, 'gwei')
        : ethers.formatUnits(BigInt(val), 'gwei');
      const num = parseFloat(gweiStr);
      if (isNaN(num)) return '0';
      return parseFloat(num.toFixed(2)).toString();
    } catch {
      return '0';
    }
  };

  const baseFee = estimate.baseFee != null
    ? estimate.baseFee
    : (estimate.maxFeePerGas != null && estimate.maxPriorityFeePerGas != null
        ? (BigInt(estimate.maxFeePerGas) - BigInt(estimate.maxPriorityFeePerGas)) / 2n
        : 0n);

  const priorityFee = estimate.maxPriorityFeePerGas != null ? estimate.maxPriorityFeePerGas : 0n;
  const maxFee = estimate.maxFeePerGas != null
    ? estimate.maxFeePerGas
    : (BigInt(baseFee) * 2n + BigInt(priorityFee));

  const baseStr = formatGweiValue(baseFee);
  const priorityStr = formatGweiValue(priorityFee);
  const maxStr = formatGweiValue(maxFee);

  return `Base: ${baseStr} gwei | Priority: ${priorityStr} gwei | Max: ${maxStr} gwei`;
}

function parseGweiOrDefault(value, fallbackGwei) {
  const raw = value == null || value === '' ? fallbackGwei : value;
  return ethers.parseUnits(String(raw), 'gwei');
}

/**
 * Resolve gas fees using user-entered values as a floor and live estimates as an upside adjustment.
 *
 * @param {import('ethers').Provider} provider
 * @param {{maxFeePerGas?: string|number, maxPriorityFeePerGas?: string|number}} gasSettings
 * @param {'standard'|'fast'|'turbo'} [speedPreset='turbo']
 * @returns {Promise<GasEstimate & {configured: GasEstimate, estimate: GasEstimate|null, source: string}>}
 */
async function resolveGasFees(provider, gasSettings = {}, speedPreset = 'turbo') {
  const configured = {
    maxFeePerGas: parseGweiOrDefault(gasSettings.maxFeePerGas, '25.0'),
    maxPriorityFeePerGas: parseGweiOrDefault(gasSettings.maxPriorityFeePerGas, '1.5'),
    baseFee: 0n,
    estimatedGwei: String(gasSettings.maxFeePerGas || '25.0')
  };

  try {
    const liveEstimate = await estimateGas(provider, speedPreset);
    if (!liveEstimate) {
      return { ...configured, configured, estimate: null, source: 'manual' };
    }

    const maxFeePerGas = liveEstimate.maxFeePerGas > configured.maxFeePerGas
      ? liveEstimate.maxFeePerGas
      : configured.maxFeePerGas;
    const maxPriorityFeePerGas = liveEstimate.maxPriorityFeePerGas > configured.maxPriorityFeePerGas
      ? liveEstimate.maxPriorityFeePerGas
      : configured.maxPriorityFeePerGas;

    return {
      maxFeePerGas,
      maxPriorityFeePerGas,
      baseFee: liveEstimate.baseFee,
      estimatedGwei: ethers.formatUnits(maxFeePerGas, 'gwei'),
      configured,
      estimate: liveEstimate,
      source: 'manual_floor_plus_live'
    };
  } catch (error) {
    return { ...configured, configured, estimate: null, source: 'manual' };
  }
}

function formatGasSelection(gasFees) {
  if (!gasFees) {
    return 'Using manual gas settings';
  }

  const using = formatGasEstimate(gasFees);
  if (!gasFees.estimate) {
    return `Using manual: ${using}`;
  }

  return `Manual floor: ${formatGasEstimate(gasFees.configured)} | Live ${formatGasEstimate(gasFees.estimate)} | Using ${using}`;
}

module.exports = {
  estimateGas,
  formatGasEstimate,
  resolveGasFees,
  formatGasSelection
};
