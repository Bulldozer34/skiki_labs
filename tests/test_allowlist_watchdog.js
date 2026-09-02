require('dotenv').config();
const assert = require('assert');
const { ethers } = require('ethers');
const { validateAllowlistPrice, getOpenSeaApiKeys } = require('../src/engines/allowlistMintEngine');

let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
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

async function run() {
  console.log('\n🧪 Running Allowlist Watchdog & Protection Unit Test Suite...\n');

  const maxCeilingWei = ethers.parseEther('0.05'); // 0.05 ETH ceiling

  // 1. Bait & Switch: Free -> Paid
  await test('Watchdog: Blocks Free -> Paid Bait & Switch with immediate abort', async () => {
    const calldataValWei = ethers.parseEther('0.02'); // Dev stealthily changed to 0.02 ETH
    const expectedPriceWei = 0n;
    const expectedIsFree = true;

    assert.throws(
      () => validateAllowlistPrice(calldataValWei, expectedPriceWei, expectedIsFree),
      /Bait & switch prevented: creator raised allowlist price from FREE/
    );
  });

  // 2. Paid -> Free (Price Drop)
  await test('Watchdog: Allows Paid -> Free and updates value to 0 ETH', async () => {
    const calldataValWei = 0n; // Dev made it free!
    const expectedPriceWei = ethers.parseEther('0.02');
    const expectedIsFree = false;

    const res = validateAllowlistPrice(calldataValWei, expectedPriceWei, expectedIsFree);
    assert.strictEqual(res.status, 'PRICE_DROPPED_TO_FREE');
    assert.strictEqual(res.valueWei, 0n);
  });

  // 3. Normal Situation: No Price Change
  await test('Watchdog: Allows Normal unchanged price execution', async () => {
    const calldataValWei = ethers.parseEther('0.02');
    const expectedPriceWei = ethers.parseEther('0.02');
    const expectedIsFree = false;

    const res = validateAllowlistPrice(calldataValWei, expectedPriceWei, expectedIsFree);
    assert.strictEqual(res.status, 'NORMAL');
    assert.strictEqual(res.valueWei, calldataValWei);
  });

  // 4. Price Increase
  await test('Watchdog: Blocks price increase above armed expected price', async () => {
    const calldataValWei = ethers.parseEther('0.04'); // Raised from 0.02 to 0.04
    const expectedPriceWei = ethers.parseEther('0.02');
    const expectedIsFree = false;

    assert.throws(
      () => validateAllowlistPrice(calldataValWei, expectedPriceWei, expectedIsFree),
      /Price increase prevented: creator raised allowlist price/
    );
  });

  // 5. Allowlist High-Value Drop Allowed (MAX_MINT_ETH not enforced on intentional allowlist drops)
  await test('Watchdog: Allows intentional paid allowlist drops (MAX_MINT_ETH is for copy-mint only)', async () => {
    const calldataValWei = ethers.parseEther('0.25'); // e.g. intentional 0.25 ETH allowlist mint
    const expectedPriceWei = ethers.parseEther('0.25');
    const expectedIsFree = false;

    const res = validateAllowlistPrice(calldataValWei, expectedPriceWei, expectedIsFree);
    assert.strictEqual(res.status, 'NORMAL');
    assert.strictEqual(res.valueWei, calldataValWei);
  });

  // 6. Multi-Key API Rotation
  await test('Multi-Key: Correctly retrieves primary and secondary OpenSea keys', async () => {
    const keys = getOpenSeaApiKeys();
    assert(Array.isArray(keys));
    assert(keys.length >= 1, 'Should find at least primary OPENSEA_API_KEY');
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
