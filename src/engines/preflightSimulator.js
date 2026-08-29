const { ethers } = require('ethers');
const { translate } = require('../utils/errorTranslator');

// Common SeaDrop and ERC-721/1155 Custom Error Signatures
const COMMON_ERRORS_ABI = [
  'error NotActive()',
  'error MintNotLive()',
  'error DropNotActive()',
  'error DropStageNotActive()',
  'error AllowlistStageNotActive()',
  'error TokenGatedDropStageNotActive()',
  'error ExceedsMaxPerWallet(uint256 max, uint256 current)',
  'error MintQuantityExceedsMaxMintedPerWallet(uint256 total, uint256 allowed)',
  'error InsufficientPayment(uint256 expected, uint256 actual)',
  'error MintQuantityCannotBeZero()',
  'error MerkleProofInvalid()',
  'error InvalidProof()',
  'error SignerNotAuthorized()',
  'error InvalidSignature()',
  'error InvalidFeeRecipient(address feeRecipient)',
  'error FeeRecipientCannotBeZeroAddress()',
  'error CreatorPayoutAddressCannotBeZeroAddress()',
  'error DuplicateFeeRecipient()',
  'error FeeRecipientNotAllowed()',
  'error FeeRecipientRestrictionNotAllowed()',
  'error SoldOut()',
  'error MaxSupplyExceeded()',
  'error InvalidPrice()',
  'error OnlyOwner()',
  'error OnlyINonFungibleSeaDropToken()',
  'error Unauthorized()'
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
   * @param {boolean} [skipGasEstimate=false] If true, skips estimateGas to save 1 RPC round trip
   * @returns {Promise<{ success: boolean, revertReason: string|null, estimatedGas: bigint|null }>}
   */
  async simulate(tx, skipGasEstimate = false) {
    try {
      const resultData = await this.provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n
      });

      let estimatedGas = null;
      if (!skipGasEstimate) {
        estimatedGas = await this.provider.estimateGas({
          from: tx.from,
          to: tx.to,
          data: tx.data,
          value: tx.value || 0n
        }).catch(() => null);
      }

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
   * Replay a reverted on-chain transaction at a specific block to decode the exact revert error
   * @param {object} tx { from, to, data, value, gasLimit }
   * @param {number|string} [blockNumber]
   * @returns {Promise<{ reason: string, simple: string, customError: string|null }>}
   */
  async decodeOnChainRevert(tx, blockNumber) {
    try {
      await this.provider.call({
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: tx.value || 0n,
        gasLimit: tx.gasLimit || 300000
      }, blockNumber || 'latest');

      return {
        reason: 'Reverted on-chain (simulation passed upon replay)',
        simple: 'Transaction failed on-chain during execution. Check block timestamp or mint limits.',
        customError: null
      };
    } catch (error) {
      const parsed = this.decodeRevertError(error);
      const customErrorName = this.extractCustomErrorName(error);
      const translated = translate(parsed);
      return {
        reason: parsed,
        simple: translated.translated ? translated.simple : parsed,
        customError: customErrorName
      };
    }
  }

  /**
   * Extract custom error name if present
   * @param {Error} error
   * @returns {string|null}
   */
  extractCustomErrorName(error) {
    const errorData = error.data || error.info?.error?.data || error.error?.data;
    if (errorData && typeof errorData === 'string' && errorData.startsWith('0x') && errorData.length > 2) {
      try {
        const decoded = this.iface.parseError(errorData);
        if (decoded) return `${decoded.name}()`;
      } catch (e) {}
    }
    return null;
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
