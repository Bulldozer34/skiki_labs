/**
 * Automated Test Suite — Copy-Mint Engine & Whale Tracker Modules.
 */

const assert = require('assert');
const { ethers } = require('ethers');
const dedupeStore = require('../src/engines/dedupeStore');
const { classifyMintTransaction, KNOWN_MINT_SELECTORS, KNOWN_NON_MINT_SELECTORS } = require('../src/engines/mintClassifier');
const {
  rewriteMintCalldataForWallet,
  rewriteMintCalldataQuantity,
  hijackSeaDropCalldata
} = require('../src/engines/calldataRewriter');
const PaymentDetector = require('../src/engines/paymentDetector');
const trackedWalletService = require('../src/services/trackedWalletService');
const CopyMintEngine = require('../src/engines/copyMintEngine');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${name}`);
    console.error(err);
    failedTests++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${name}`);
    console.error(err);
    failedTests++;
  }
}

console.log('\n🧪 Running Copy-Mint Engine Test Suite...\n');

// 1. DedupeStore Tests
test('DedupeStore: Correctly identifies new vs duplicate source tx hash', () => {
  const testHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  dedupeStore.clear();

  assert.strictEqual(dedupeStore.checkSourceTx(testHash), false, 'New hash should not be duplicate');
  dedupeStore.markSourceTx(testHash);
  assert.strictEqual(dedupeStore.checkSourceTx(testHash), true, 'Marked hash must be identified as duplicate');
});

test('DedupeStore: Tracks contract execution tuples', () => {
  const contract = '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
  const data = '0x161ac21f000000000000000000000000';
  const val = '1000000000000000';

  assert.strictEqual(dedupeStore.checkContractExecution(contract, data, val), false);
  dedupeStore.markExecuted('exec-1', contract, data, val);
  assert.strictEqual(dedupeStore.checkContractExecution(contract, data, val), true);
});

// 2. MintClassifier Tests
test('MintClassifier: Correctly identifies known SeaDrop and ERC-721 mint selectors', () => {
  const seadropCalldata = '0x161ac21f000000000000000000000000';
  const genericMintCalldata = '0xa0712d680000000000000000000000000000000000000000000000000000000000000001';

  const res1 = classifyMintTransaction(seadropCalldata, '0');
  assert.strictEqual(res1.isMint, true);
  assert.strictEqual(res1.confidence, 'high');
  assert.strictEqual(res1.selector, '0x161ac21f');

  const res2 = classifyMintTransaction(genericMintCalldata, '1000000000000000');
  assert.strictEqual(res2.isMint, true);
  assert.strictEqual(res2.confidence, 'high');
  assert.strictEqual(res2.selector, '0xa0712d68');
});

test('MintClassifier: Rejects known non-mint calls (ERC20 transfer, approve, Seaport)', () => {
  const transferCalldata = '0xa9059cbb0000000000000000000000001111111111111111111111111111111111111111000000000000000000000000000000000000000000000000000000000000000a';
  const approveCalldata = '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const seaportCalldata = '0xfb0f3ee1000000000000000000000000';

  assert.strictEqual(classifyMintTransaction(transferCalldata, '0').isMint, false);
  assert.strictEqual(classifyMintTransaction(approveCalldata, '0').isMint, false);
  assert.strictEqual(classifyMintTransaction(seaportCalldata, '1000000000000000').isMint, false);
});

// 3. CalldataRewriter Tests
test('CalldataRewriter: Successfully rewrites SeaDrop mintPublic minter address', () => {
  const nftContract = '0x1111111111111111111111111111111111111111';
  const feeRecipient = '0x2222222222222222222222222222222222222222';
  const whaleAddress = '0x3333333333333333333333333333333333333333';
  const botWallet = '0x4444444444444444444444444444444444444444';

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const rawData = '0x161ac21f' + coder.encode(
    ['address', 'address', 'address', 'uint256'],
    [nftContract, feeRecipient, whaleAddress, 1]
  ).slice(2);

  const rewritten = rewriteMintCalldataForWallet(rawData, botWallet, whaleAddress);
  assert.notStrictEqual(rewritten, rawData);

  // Decode rewritten calldata
  const [decNft, decFee, decMinter, decQty] = coder.decode(
    ['address', 'address', 'address', 'uint256'],
    '0x' + rewritten.slice(10)
  );

  assert.strictEqual(decNft.toLowerCase(), nftContract.toLowerCase());
  assert.strictEqual(decMinter.toLowerCase(), botWallet.toLowerCase(), 'Minter must be rewritten to bot wallet');
  assert.strictEqual(Number(decQty), 1);
});

test('CalldataRewriter: Successfully scales SeaDrop quantity', () => {
  const nftContract = '0x1111111111111111111111111111111111111111';
  const feeRecipient = '0x2222222222222222222222222222222222222222';
  const botWallet = '0x4444444444444444444444444444444444444444';

  const coder = ethers.AbiCoder.defaultAbiCoder();
  const rawData = '0x161ac21f' + coder.encode(
    ['address', 'address', 'address', 'uint256'],
    [nftContract, feeRecipient, botWallet, 1]
  ).slice(2);

  const scaled = rewriteMintCalldataQuantity(rawData, 3, 1);
  const [, , , decQty] = coder.decode(
    ['address', 'address', 'address', 'uint256'],
    '0x' + scaled.slice(10)
  );

  assert.strictEqual(Number(decQty), 3, 'Quantity must be scaled to 3');
});

// 4. TrackedWalletService Tests
test('TrackedWalletService: Add, check, toggle, and remove whale wallets', () => {
  const testWhale = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
  trackedWalletService.removeWallet(testWhale);

  assert.strictEqual(trackedWalletService.isTracked(testWhale), false);

  const entry = trackedWalletService.addWallet(testWhale, 'Vitalik Alpha');
  assert.strictEqual(entry.label, 'Vitalik Alpha');
  assert.strictEqual(trackedWalletService.isTracked(testWhale), true);

  trackedWalletService.toggleActive(testWhale);
  assert.strictEqual(trackedWalletService.isTracked(testWhale), false, 'Paused wallet should not be actively tracked');

  trackedWalletService.toggleActive(testWhale);
  assert.strictEqual(trackedWalletService.isTracked(testWhale), true, 'Resumed wallet should be actively tracked');

  trackedWalletService.removeWallet(testWhale);
  assert.strictEqual(trackedWalletService.isTracked(testWhale), false);
});

// 5. PaymentDetector Safety Limit Tests
(async () => {
  await asyncTest('PaymentDetector: Rejects mint exceeding max ETH ceiling', async () => {
    // 0.1 ETH source value with 0.05 ETH limit
    const plan = await PaymentDetector.detect({
      provider: null,
      contractAddress: '0x1111111111111111111111111111111111111111',
      calldata: '0x161ac21f',
      sourceTxValue: ethers.parseEther('0.1').toString(),
      executingWallet: '0x4444444444444444444444444444444444444444',
      maxMintEth: 0.05,
      skipSimulation: true
    });

    assert.strictEqual(plan.shouldExecute, false, 'Must reject mint exceeding max ETH limit');
    assert.strictEqual(plan.paymentMode, 'rejected');
  });

  await asyncTest('PaymentDetector: Allows free 0 ETH mints under ceiling', async () => {
    const plan = await PaymentDetector.detect({
      provider: null,
      contractAddress: '0x1111111111111111111111111111111111111111',
      calldata: '0x161ac21f',
      sourceTxValue: '0',
      executingWallet: '0x4444444444444444444444444444444444444444',
      maxMintEth: 0.05,
      skipSimulation: true
    });

    assert.strictEqual(plan.shouldExecute, true);
    assert.strictEqual(plan.paymentMode, 'free');
    assert.strictEqual(plan.selectedValueEth, '0.0');
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  }
})();
