/**
 * Calldata Rewriter — Replaces whale recipient address with executing bot wallet address.
 *
 * Ensures minted NFTs are minted directly to your burner wallet rather than the whale's wallet.
 * Supports SeaDrop, Manifold, Zora, standard ERC-721/1155, and quantity rewriting.
 */

const { ethers, AbiCoder, Interface } = require('ethers');

const SEADROP_SELECTORS = new Set(['0x161ac21f', '0x51061988']);
const MANIFOLD_SELECTORS = new Set(['0xfa2b068f', '0x731133e9', '0x156e29f6']);
const ZORA_MINT_WITH_REWARDS = '0x0f4a1e5e';

const MANIFOLD_IFACE = new Interface([
  'function mint(address to, uint256 customFeeToken, uint256 count, address[] recipients, uint256[] amounts)',
  'function mint(address to, uint256 customFeeToken, uint256 count, bytes extraData)',
  'function mint(address to, uint256 customFeeToken, uint256 count)'
]);

const ZORA_IFACE = new Interface([
  'function mintWithRewards(address recipient, uint256 quantity, string comment, address mintReferral)'
]);

const DIRECT_IFACES = [
  new Interface([
    'function mint(address to, uint256 quantity)',
    'function mint(address to)',
    'function mint(uint256 quantity)',
    'function mint()',
    'function publicMint(address to, uint256 quantity)',
    'function publicMint(uint256 quantity)',
    'function purchaseTo(address to, uint256 quantity)',
    'function purchase(uint256 quantity)',
    'function claim(address to, uint256 quantity)',
    'function batchMint(address to, uint256 quantity)'
  ])
];

function padAddressInCalldata(addr) {
  if (!addr) return '';
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

/**
 * Hijack SeaDrop mintPublic calldata to replace minter address
 */
function hijackSeaDropCalldata(originalData, newMinter) {
  if (!originalData || originalData.length < 10) return null;
  const selector = originalData.slice(0, 10).toLowerCase();
  if (!SEADROP_SELECTORS.has(selector)) return null;

  try {
    const coder = AbiCoder.defaultAbiCoder();
    const payload = '0x' + originalData.slice(10);
    const [nftContract, feeRecipient, minter, quantity] = coder.decode(
      ['address', 'address', 'address', 'uint256'],
      payload
    );

    return (
      selector +
      coder
        .encode(
          ['address', 'address', 'address', 'uint256'],
          [nftContract, feeRecipient, newMinter, quantity]
        )
        .slice(2)
    );
  } catch {
    return null;
  }
}

/**
 * Hijack Manifold mint calldata
 */
function hijackManifoldCalldata(originalData, newMinter, whaleAddress) {
  if (!originalData || originalData.length < 10) return null;
  const selector = originalData.slice(0, 10).toLowerCase();
  if (!MANIFOLD_SELECTORS.has(selector)) return null;

  try {
    const coder = AbiCoder.defaultAbiCoder();
    const payload = '0x' + originalData.slice(10);

    if (selector === '0x156e29f6') {
      const [to, feeToken, count] = coder.decode(['address', 'uint256', 'uint256'], payload);
      return selector + coder.encode(['address', 'uint256', 'uint256'], [newMinter, feeToken, count]).slice(2);
    }
    if (selector === '0x731133e9') {
      const [to, feeToken, count, extra] = coder.decode(['address', 'uint256', 'uint256', 'bytes'], payload);
      return selector + coder.encode(['address', 'uint256', 'uint256', 'bytes'], [newMinter, feeToken, count, extra]).slice(2);
    }
    if (selector === '0xfa2b068f') {
      const [to, feeToken, count, addrs, amounts] = coder.decode(
        ['address', 'uint256', 'uint256', 'address[]', 'uint256[]'],
        payload
      );
      return (
        selector +
        coder
          .encode(
            ['address', 'uint256', 'uint256', 'address[]', 'uint256[]'],
            [newMinter, feeToken, count, addrs, amounts]
          )
          .slice(2)
      );
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Hijack Zora mintWithRewards calldata
 */
function hijackZoraCalldata(originalData, newMinter) {
  if (!originalData || originalData.length < 10) return null;
  const selector = originalData.slice(0, 10).toLowerCase();
  if (selector !== ZORA_MINT_WITH_REWARDS) return null;

  try {
    const coder = AbiCoder.defaultAbiCoder();
    const payload = '0x' + originalData.slice(10);
    const [recipient, quantity, comment, referral] = coder.decode(
      ['address', 'uint256', 'string', 'address'],
      payload
    );

    return (
      ZORA_MINT_WITH_REWARDS +
      coder
        .encode(['address', 'uint256', 'string', 'address'], [newMinter, quantity, comment, referral])
        .slice(2)
    );
  } catch {
    return null;
  }
}

/**
 * Rewrite calldata for target wallet address.
 *
 * @param {string} originalData - Whale calldata
 * @param {string} walletAddress - Bot wallet address
 * @param {string} [whaleAddress] - Whale wallet address to substitute
 * @returns {string} Rewritten calldata
 */
function rewriteMintCalldataForWallet(originalData, walletAddress, whaleAddress = '') {
  if (!originalData || originalData.length < 10) return originalData;

  // 1. SeaDrop
  const sea = hijackSeaDropCalldata(originalData, walletAddress);
  if (sea) return sea;

  // 2. Manifold
  const manifold = hijackManifoldCalldata(originalData, walletAddress, whaleAddress);
  if (manifold) return manifold;

  // 3. Zora
  const zora = hijackZoraCalldata(originalData, walletAddress);
  if (zora) return zora;

  // 4. Standard Interface Parsing
  for (const iface of DIRECT_IFACES) {
    try {
      const parsed = iface.parseTransaction({ data: originalData });
      if (parsed) {
        const args = [...parsed.args];
        let replaced = false;

        for (let i = 0; i < args.length; i++) {
          if (
            typeof args[i] === 'string' &&
            ethers.isAddress(args[i]) &&
            (!whaleAddress || args[i].toLowerCase() === whaleAddress.toLowerCase())
          ) {
            args[i] = walletAddress;
            replaced = true;
          }
        }

        if (replaced) {
          return iface.encodeFunctionData(parsed.fragment, args);
        }
      }
    } catch {
      // Continue to fallback
    }
  }

  // 5. Direct Hex Padded Address Substitution (last resort)
  if (whaleAddress && ethers.isAddress(whaleAddress)) {
    const whalePad = padAddressInCalldata(whaleAddress);
    const walletPad = padAddressInCalldata(walletAddress);
    const lowerData = originalData.toLowerCase();

    if (lowerData.includes(whalePad)) {
      return '0x' + lowerData.replace(new RegExp(whalePad, 'g'), walletPad).slice(2);
    }
  }

  return originalData;
}

/**
 * Rewrite quantity parameter in calldata for max-mint scaling.
 *
 * @param {string} originalData - Original calldata
 * @param {number} newQuantity - Desired quantity
 * @param {number} [prevQuantity=1] - Previous quantity
 * @returns {string|null}
 */
function rewriteMintCalldataQuantity(originalData, newQuantity, prevQuantity = 1) {
  if (!originalData || originalData.length < 10 || newQuantity < 1) return originalData;
  if (newQuantity === prevQuantity) return originalData;

  const selector = originalData.slice(0, 10).toLowerCase();

  // SeaDrop public quantity
  if (SEADROP_SELECTORS.has(selector)) {
    try {
      const coder = AbiCoder.defaultAbiCoder();
      const payload = '0x' + originalData.slice(10);
      const [nft, feeRecipient, minter] = coder.decode(
        ['address', 'address', 'address', 'uint256'],
        payload
      );
      return (
        selector +
        coder
          .encode(
            ['address', 'address', 'address', 'uint256'],
            [nft, feeRecipient, minter, BigInt(newQuantity)]
          )
          .slice(2)
      );
    } catch {
      return originalData;
    }
  }

  // Generic Interfaces
  for (const iface of [...DIRECT_IFACES, ZORA_IFACE]) {
    try {
      const parsed = iface.parseTransaction({ data: originalData });
      if (parsed) {
        const args = [...parsed.args];
        let replaced = false;

        for (let i = 0; i < args.length; i++) {
          if (
            typeof args[i] === 'bigint' &&
            args[i] > 0n &&
            args[i] < 1000000n &&
            Number(args[i]) === prevQuantity
          ) {
            args[i] = BigInt(newQuantity);
            replaced = true;
          }
        }

        if (replaced) {
          return iface.encodeFunctionData(parsed.fragment, args);
        }
      }
    } catch {
      // Continue
    }
  }

  return originalData;
}

module.exports = {
  rewriteMintCalldataForWallet,
  rewriteMintCalldataQuantity,
  hijackSeaDropCalldata,
  hijackManifoldCalldata,
  hijackZoraCalldata
};
