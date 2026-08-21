/**
 * Error Translator — converts raw blockchain/network errors into plain English
 * 
 * Used by both mint engines and the preflight simulator to give users
 * clear, actionable feedback when a mint fails.
 */

const ERROR_MAP = [
  // ── Insufficient Funds ──
  {
    patterns: [/insufficient funds/i, /INSUFFICIENT_FUNDS/i, /sender doesn't have enough funds/i],
    simple: "Your wallet doesn't have enough ETH to cover the mint price + gas fees.",
    action: "Add more ETH to your wallet and try again."
  },

  // ── Mint Not Live ──
  {
    patterns: [/NotActive/i, /MintNotLive/i, /mint is not active/i, /not yet started/i],
    simple: "The mint hasn't started yet.",
    action: "Check the start time and try again, or use Auto-Schedule mode."
  },

  // ── Allowlist Stage Not Active ──
  {
    patterns: [/AllowlistStageNotActive/i, /allowlist.*not.*active/i],
    simple: "The allowlist mint stage is not active right now.",
    action: "Wait for the allowlist stage to open, or check if you're in the right mint window."
  },

  // ── Max Per Wallet Exceeded ──
  {
    patterns: [/ExceedsMaxPerWallet/i, /max.*per.*wallet/i, /exceeds.*max/i, /already claimed/i],
    simple: "You've already minted the maximum number of NFTs allowed per wallet.",
    action: "Use a different wallet if you want to mint more."
  },

  // ── Insufficient Payment (price changed) ──
  {
    patterns: [/InsufficientPayment/i, /insufficient.*payment/i, /not enough.*value/i],
    simple: "The ETH you sent isn't enough — the mint price may have changed.",
    action: "Check the current mint price on OpenSea and try again."
  },

  // ── Not on Allowlist ──
  {
    patterns: [/MerkleProofInvalid/i, /invalid.*proof/i, /not.*allowlist/i, /not.*whitelist/i],
    simple: "Your wallet is not on the allowlist for this mint.",
    action: "Make sure your wallet address was added to the project's allowlist."
  },

  // ── Invalid Signature ──
  {
    patterns: [/InvalidSignature/i, /SignerNotAuthorized/i, /signature.*invalid/i],
    simple: "The mint signature is invalid or expired.",
    action: "Re-authenticate your wallet and try again. The session may have expired."
  },

  // ── Zero Quantity ──
  {
    patterns: [/MintQuantityCannotBeZero/i, /quantity.*zero/i],
    simple: "Mint quantity cannot be zero.",
    action: "Set the quantity to at least 1."
  },

  // ── Token Gated ──
  {
    patterns: [/TokenGatedDropStageNotActive/i, /token.*gated/i],
    simple: "This mint requires you to hold a specific token to participate.",
    action: "Check the project's requirements — you may need to hold a specific NFT or token."
  },

  // ── Nonce Too Low ──
  {
    patterns: [/nonce too low/i, /nonce.*already.*used/i],
    simple: "Another transaction was already sent from this wallet.",
    action: "Wait for your pending transaction to confirm, then try again."
  },

  // ── Replacement Underpriced ──
  {
    patterns: [/replacement transaction underpriced/i, /replacement.*underpriced/i],
    simple: "A previous transaction is still pending with higher gas.",
    action: "Wait for the pending transaction to confirm, or increase your gas settings."
  },

  // ── Execution Reverted (generic) ──
  {
    patterns: [/execution reverted/i, /CALL_EXCEPTION/i, /transaction.*reverted/i, /revert/i],
    simple: "The smart contract rejected the transaction.",
    action: "The mint may not be live yet, your wallet may not be eligible, or the collection is sold out."
  },

  // ── Network / Connection Errors ──
  {
    patterns: [/ETIMEDOUT/i, /ECONNREFUSED/i, /ECONNRESET/i, /ENOTFOUND/i, /timeout/i, /network.*error/i],
    simple: "Could not connect to the network.",
    action: "Check your internet connection and RPC URL, then try again."
  },

  // ── Server Errors ──
  {
    patterns: [/502/i, /503/i, /504/i, /server.*error/i, /bad gateway/i, /service unavailable/i],
    simple: "The RPC server is overloaded or down.",
    action: "Try a different RPC endpoint (e.g., switch from a public RPC to Alchemy)."
  },

  // ── Rate Limited ──
  {
    patterns: [/429/i, /rate.*limit/i, /too many requests/i, /throttl/i],
    simple: "You're sending too many requests — the server rate-limited you.",
    action: "Wait a few seconds and try again, or use a paid RPC with higher limits."
  },

  // ── Gas Too Low ──
  {
    patterns: [/gas too low/i, /intrinsic gas too low/i, /out of gas/i, /gas.*exceed/i],
    simple: "The gas limit is too low for this transaction.",
    action: "Increase the Gas Limit setting (try 400000 or higher)."
  },

  // ── Already Known (benign) ──
  {
    patterns: [/already known/i, /already imported/i, /tx already exists/i],
    simple: "This transaction was already submitted to the network.",
    action: "No action needed — the transaction is already in the mempool."
  }
];

/**
 * Translate a raw error message into a human-readable explanation.
 * 
 * @param {string|Error} error - The raw error message or Error object
 * @returns {{ original: string, simple: string, action: string, translated: boolean }}
 */
function translate(error) {
  const message = typeof error === 'string' ? error : (error?.message || error?.shortMessage || String(error));

  for (const entry of ERROR_MAP) {
    for (const pattern of entry.patterns) {
      if (pattern.test(message)) {
        return {
          original: message,
          simple: entry.simple,
          action: entry.action,
          translated: true
        };
      }
    }
  }

  // No match — return the original with a generic wrapper
  return {
    original: message,
    simple: "Something went wrong with the transaction.",
    action: "Check the error details above and try again. If it keeps happening, check your RPC, gas settings, and wallet balance.",
    translated: false
  };
}

/**
 * Format a translated error into a single human-readable log line.
 * 
 * @param {string|Error} error - The raw error
 * @returns {string} Formatted string like "Not enough ETH → Add more ETH and try again"
 */
function formatError(error) {
  const t = translate(error);
  return `${t.simple} → ${t.action}`;
}

module.exports = { translate, formatError, ERROR_MAP };
