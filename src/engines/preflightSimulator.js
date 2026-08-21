const { ethers } = require('ethers');
const { translate } = require('../utils/errorTranslator');

// Common SeaDrop and ERC-721/1155 Custom Error Signatures
const COMMON_ERRORS_ABI = [
  'error NotActive()',
  'error MintNotLive()',
  'error AllowlistStageNotActive()',
  'error ExceedsMaxPerWallet(uint256 max, uint256 current)',
  'error InsufficientPayment(uint256 expected, uint256 actual)',
  'error MintQuantityCannotBeZero()',
  'error MerkleProofInvalid()',
  'error SignerNotAuthorized()',
  'error InvalidSignature()',
  'error TokenGatedDropStageNotActive()'
];

class PreflightSimulator {
  /**
   * @param {ethers.Provider} provider 
   */
  constructor(provider) {
    this.provider = provider;
    this.iface = new ethers.Interface(COMMON_ERRORS_ABI);
  }

  /**
   * Simulate transaction execution before sending (0 gas cost)
   * @param {object} tx { from, to, data, value }
   * @returns {Promise<{ success: boolean, revertReason: string|null, estimatedGas: bigint|null }>}
   */
  async simulate(tx) {
    try {
      const resultData = await this.provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n
      });

      const estimatedGas = await this.provider.estimateGas({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n
      }).catch(() => null);

      return {
        success: true,
        revertReason: null,
        estimatedGas,
        resultData
      };
    } catch (error) {
      const parsedRevert = this.decodeRevertError(error);
      return {
        success: false,
        revertReason: parsedRevert,
        estimatedGas: null,
        resultData: null
      };
    }
  }

  /**
   * Decode hex error return data or standard revert strings
   * @param {Error} error 
   * @returns {string}
   */
  decodeRevertError(error) {
    const errorData = error.data || error.info?.error?.data || error.error?.data;
    let technicalReason = null;

    if (errorData && typeof errorData === 'string' && errorData.startsWith('0x') && errorData.length > 2) {
      try {
        const decoded = this.iface.parseError(errorData);
        if (decoded) {
          const args = decoded.args && decoded.args.length > 0 ? ` (${decoded.args.join(', ')})` : '';
          technicalReason = `Contract Revert: ${decoded.name}${args}`;
        }
      } catch (e) {
        // Not in custom errors ABI
      }
    }

    if (!technicalReason) {
      technicalReason = error.reason || error.shortMessage || error.message || 'Simulation Reverted';
    }

    // Append human-readable explanation
    const translated = translate(technicalReason);
    if (translated.translated) {
      return `${technicalReason} — ${translated.simple}`;
    }
    return technicalReason;
  }
}

module.exports = PreflightSimulator;
