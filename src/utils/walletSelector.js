/**
 * Wallet Number Selector & Parser.
 *
 * Allows users to select specific numbered wallets (e.g. "1, 3, 7" or "1-5" or "1-3, 5, 8-10")
 * for paid mint execution while leaving all wallets available for free mints.
 */

/**
 * Parse a user input string (e.g. "1, 3, 7", "1-5", "all", "none") into 0-indexed wallet indices.
 *
 * @param {string} input - User input string (e.g. "1, 3, 7" or "1-5")
 * @param {number} totalWallets - Total number of available wallets
 * @returns {Array<number>} Array of 0-based wallet indices (e.g. [0, 2, 6])
 */
function parseWalletNumbers(input, totalWallets = 100) {
  if (!input) {
    return Array.from({ length: totalWallets }, (_, i) => i);
  }

  const str = String(input).trim().toLowerCase();

  if (str === 'all' || str === '*') {
    return Array.from({ length: totalWallets }, (_, i) => i);
  }

  if (str === 'none' || str === '0' || str === 'free_only') {
    return [];
  }

  const indices = new Set();
  const chunks = str.split(/[,;\s]+/).filter(Boolean);

  for (const chunk of chunks) {
    // Handle ranges like "1-5" or "1..5"
    if (chunk.includes('-') || chunk.includes('..')) {
      const parts = chunk.split(/[-.]+/).filter(Boolean);
      if (parts.length === 2) {
        const start = parseInt(parts[0], 10);
        const end = parseInt(parts[1], 10);

        if (!isNaN(start) && !isNaN(end)) {
          const min = Math.max(1, Math.min(start, end));
          const max = Math.min(totalWallets, Math.max(start, end));
          for (let w = min; w <= max; w++) {
            indices.add(w - 1); // convert 1-based to 0-based
          }
        }
      }
    } else {
      // Single number (e.g. "3")
      const num = parseInt(chunk, 10);
      if (!isNaN(num) && num >= 1 && num <= totalWallets) {
        indices.add(num - 1);
      }
    }
  }

  return Array.from(indices).sort((a, b) => a - b);
}

/**
 * Format wallet indices into a clean human-readable string (e.g. "Wallets #1, #3, #7")
 *
 * @param {Array<number>} indices - 0-based indices
 * @param {number} totalWallets - Total wallet count
 * @returns {string} Formatted label
 */
function formatWalletNumbers(indices, totalWallets) {
  if (!indices || indices.length === 0) {
    return 'None (Free Mints Only)';
  }

  if (indices.length === totalWallets) {
    return `All (${totalWallets} Wallets)`;
  }

  const humanNumbers = indices.map(i => `#${i + 1}`);

  // Check if consecutive range of 4 or more
  if (indices.length >= 4) {
    let isRange = true;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] !== indices[0] + i) {
        isRange = false;
        break;
      }
    }
    if (isRange) {
      return `#${indices[0] + 1}–#${indices[indices.length - 1] + 1} (${indices.length} wallets)`;
    }
  }

  if (humanNumbers.length <= 4) {
    return `${humanNumbers.join(', ')} (${indices.length} wallet${indices.length > 1 ? 's' : ''})`;
  }

  return `${humanNumbers.slice(0, 3).join(', ')}... (+${humanNumbers.length - 3} more)`;
}

module.exports = {
  parseWalletNumbers,
  formatWalletNumbers
};
