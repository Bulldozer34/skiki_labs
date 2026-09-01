/**
 * Mint Classifier — Identifies whether a transaction is an NFT mint.
 *
 * Distinguishes true NFT mints from standard ERC-20 transfers, DEX swaps,
 * marketplace trades, and administrative contract calls.
 *
 * Ported & adapted from ultra-dads-copy-mint-bot architecture.
 */

// ---- Known MINT selectors (high confidence) ----
const KNOWN_MINT_SELECTORS = {
  // Generic ERC-721 / ERC-1155 mint patterns
  '0xa0712d68': 'mint(uint256)',
  '0x1249c58b': 'mint()',
  '0x40c10f19': 'mint(address,uint256)',
  '0x6a627842': 'mint(address)',
  '0xa14481e9': 'mint(address,uint256)',
  '0xefef39a1': 'mint(uint256,bytes32[])',
  '0x2db11544': 'mint(uint256)',
  '0xf3b2dc9d': 'mint(uint256)',
  '0x33b66418': 'mint(uint256)',
  '0x94bf804d': 'mint(uint256,address)',
  '0xc6786e81': 'mint(address,uint256,bytes)',
  '0x14f71077': 'mint(uint256,bytes)',

  // SeaDrop (OpenSea)
  '0x161ac21f': 'mintPublic(address,address,address,uint256)',
  '0x51061988': 'mintPublic(address,address,address,uint256) [legacy v1.1]',
  '0x46332f08': 'mintAllowlist(address,address,address,uint256,bytes32[])',
  '0x00000000': 'mintSigned(address,address,address,uint256,(uint256,uint256,uint256,uint256,uint256,address,bytes))',

  // Manifold
  '0xfa2b068f': 'mint(address,uint256,uint256,address[],uint256[])',
  '0x731133e9': 'mint(address,uint256,uint256,bytes)',
  '0x156e29f6': 'mint(address,uint256,uint256)',

  // Zora / Rewards
  '0x0f4a1e5e': 'mintWithRewards(address,uint256,string,address)',
  '0xefef3911': 'mintWithRewards(address,uint256,address,bytes)',

  // thirdweb
  '0x57bc3d78': 'claim(address,uint256,address,uint256,(bytes32[],uint256,uint256,address),bytes)',
  '0x84bb1e42': 'claim(address,uint256,address,uint256,bytes32[],uint256,bytes)',
  '0x2e7ba6ef': 'claim(uint256,address,uint256,bytes32[])',

  // Art Blocks / Generative / Direct
  '0x26c43a11': 'purchaseTo(address,uint256)',
  '0xefef39a2': 'purchase(uint256)',
  '0x0d9f64f4': 'publicMint(uint256)',
  '0xfa537f59': 'publicMint()',
  '0x5a54e954': 'publicMint(address,uint256)',

  // Free / Claim style
  '0x11110000': 'freeMint()',
  '0x4d7cc1ec': 'freePlanting()',
  '0x4e71d92d': 'claim()',
  '0x379607f5': 'claim(address)',

  // Batch mints
  '0xa945bf80': 'batchMint(uint256)',
  '0x3d0b2d18': 'batchMint(address,uint256)'
};

// ---- Known NON-MINT selectors (immediate rejection) ----
const KNOWN_NON_MINT_SELECTORS = {
  // ERC20 transfers & approvals
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',
  '0x39509351': 'increaseAllowance(address,uint256)',
  '0xa457c2d7': 'decreaseAllowance(address,uint256)',

  // NFT transfers & approvals
  '0xa22cb465': 'setApprovalForAll(address,bool)',
  '0xd505accf': 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
  '0x2b67b570': 'permitTransferFrom (Permit2)',
  '0x0d58b1db': 'permitWitnessTransferFrom (Permit2)',
  '0x87013091': 'permitTransferFrom (Permit2 packed)',
  '0xf242432a': 'safeTransferFrom (ERC1155)',
  '0x42842e0e': 'safeTransferFrom (ERC721)',
  '0x2eb2c2d6': 'safeBatchTransferFrom (ERC1155)',

  // Uniswap / DEX Swaps
  '0x38ed1739': 'swapExactTokensForTokens',
  '0x7ff36ab5': 'swapExactETHForTokens',
  '0x18cbafe5': 'swapExactTokensForETH',
  '0x5c11d795': 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
  '0xfb3bdb41': 'swapETHForExactTokens',
  '0x791ac947': 'swapExactTokensForETHSupportingFeeOnTransferTokens',
  '0x04e45aaf': 'exactInputSingle (Uniswap V3)',
  '0xb858183f': 'exactInput (Uniswap V3)',
  '0x414bf389': 'exactInputSingle (Uniswap V3)',
  '0xc04b8d59': 'exactInput (Uniswap V3)',
  '0x3593564c': 'execute (Universal Router)',

  // WETH Wrappers
  '0xd0e30db0': 'deposit (WETH)',
  '0x2e1a7d4d': 'withdraw (WETH)',

  // NFT Marketplace (Seaport, LooksRare, Blur)
  '0xfb0f3ee1': 'fulfillBasicOrder (Seaport buy)',
  '0x87201b41': 'fulfillBasicOrder_efficient (Seaport buy)',
  '0xe7acab24': 'fulfillAdvancedOrder (Seaport)',
  '0xb3a34c4c': 'fulfillOrder (Seaport)',
  '0x8b7a92d2': 'fulfillAvailableAdvancedOrders (Seaport)',
  '0xf7013da0': 'matchAdvancedOrders (Seaport)',

  // Relay / Meta-tx / Safe
  '0x6a761202': 'execTransaction (Gnosis Safe)',
  '0x468721a7': 'execTransaction (Safe variant)',
  '0xb61d27f6': 'execute (forwarder/meta-tx)',
  '0x5194545c': 'multicall (relay batch)',
  '0x34fcd5be': 'executeBatch (Biconomy)',
  '0x34ee9791': 'execTransactionFromModule (Safe module)',

  // Staking / Governance
  '0xa694fc3a': 'stake(uint256)',
  '0x2e17de78': 'unstake(uint256)',
  '0x5c19a95c': 'delegate(address)',

  // Multicall
  '0xac9650d8': 'multicall(bytes[])',
  '0x5ae401dc': 'multicall(uint256,bytes[])',
  '0x252dba42': 'aggregate((address,bytes)[])'
};

function isValidHexCalldata(data) {
  return typeof data === 'string' && /^0x[0-9a-fA-F]*$/.test(data);
}

/**
 * Classify a transaction's calldata to determine if it is an NFT mint.
 *
 * @param {string} data - Calldata hex string
 * @param {string|bigint} value - Transaction msg.value in wei
 * @param {string} [to] - Target contract address
 * @param {boolean} [copyUnknownCalls=false] - Whether to allow unknown selectors
 * @returns {object} Classification result
 */
function classifyMintTransaction(data, value = '0', to = null, copyUnknownCalls = false) {
  // Empty calldata = simple ETH transfer
  if (!data || data === '0x' || data.length < 10) {
    return {
      isMint: false,
      confidence: 'high',
      selector: '0x',
      reason: 'Empty calldata (simple ETH transfer)'
    };
  }

  if (!isValidHexCalldata(data) || (data.length - 2) % 2 !== 0) {
    return {
      isMint: false,
      confidence: 'high',
      selector: data.slice(0, 10).toLowerCase(),
      reason: 'Invalid hex calldata'
    };
  }

  const selector = data.slice(0, 10).toLowerCase();

  // 1. Check known mint selectors
  if (KNOWN_MINT_SELECTORS[selector]) {
    return {
      isMint: true,
      confidence: 'high',
      selector,
      selectorName: KNOWN_MINT_SELECTORS[selector],
      reason: `Known mint method: ${KNOWN_MINT_SELECTORS[selector]}`
    };
  }

  // 2. Check known non-mint selectors
  if (KNOWN_NON_MINT_SELECTORS[selector]) {
    return {
      isMint: false,
      confidence: 'high',
      selector,
      selectorName: KNOWN_NON_MINT_SELECTORS[selector],
      reason: `Known non-mint method: ${KNOWN_NON_MINT_SELECTORS[selector]}`
    };
  }

  const valueBig = BigInt(value || '0');
  const paid = valueBig > 0n;

  // 3. Heuristic: 1 full 32-byte word argument with ETH (mint(uint256) layout)
  if (data.length === 74 && paid) {
    return {
      isMint: true,
      confidence: 'medium',
      selector,
      selectorName: 'customMint(uint256)',
      reason: 'Calldata matches mint(uint256) word shape with ETH value'
    };
  }

  // 4. Heuristic: 0 ETH long calldata with unknown selector from tracked whale (e.g. signature/allowlist claim)
  if (!paid && data.length > 200) {
    return {
      isMint: true,
      confidence: 'medium',
      selector,
      selectorName: 'allowlistOrSignedMint',
      reason: 'Long calldata with 0 ETH (likely signature or allowlist mint)'
    };
  }

  // 5. Broader short ABI-sized calldata with ETH
  if (data.length <= 138 && paid) {
    const bodyLen = data.length - 10;
    if (bodyLen > 0 && bodyLen % 64 === 0) {
      return {
        isMint: true,
        confidence: 'low',
        selector,
        selectorName: 'unknownPaidMint',
        reason: 'Short ABI-aligned calldata with ETH value (possible mint)'
      };
    }
  }

  // 6. Unknown selector with copyUnknownCalls enabled
  if (copyUnknownCalls) {
    return {
      isMint: true,
      confidence: 'low',
      selector,
      selectorName: 'unknownSelector',
      reason: 'Unknown selector permitted via COPY_UNKNOWN_MINT_CALLS'
    };
  }

  // Default: Reject
  return {
    isMint: false,
    confidence: paid ? 'medium' : 'high',
    selector,
    reason: paid
      ? 'Unknown selector with ETH (likely swap/trade/relay)'
      : 'Unknown selector with no ETH value'
  };
}

module.exports = {
  classifyMintTransaction,
  KNOWN_MINT_SELECTORS,
  KNOWN_NON_MINT_SELECTORS
};
