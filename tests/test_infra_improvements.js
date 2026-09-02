/**
 * Test Suite — Infrastructure Improvements (Multicall3, Price Cache, Connection Manager)
 */

const assert = require('assert');
const { getEthPriceUsd, convertUsdToEth, convertEthToUsd } = require('../src/utils/priceFetcher');
const connectionManager = require('../src/services/connectionManager');
const WalletService = require('../src/services/walletService');

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
  console.log('\n🧪 Running Infrastructure Improvements Test Suite...\n');

  // 1. Price fetcher with caching
  await test('PriceFetcher: Concurrent race fetches price & caches result', async () => {
    const p1 = await getEthPriceUsd();
    assert(p1 !== null && p1 > 0, 'Price should be positive number');

    // Second call should return cached value instantly
    const tStart = Date.now();
    const p2 = await getEthPriceUsd();
    const duration = Date.now() - tStart;
    assert.strictEqual(p1, p2, 'Cached price should match');
    assert(duration < 20, 'Cached lookup should take < 20ms');
  });

  // 2. Price conversion utilities
  await test('PriceFetcher: Correct conversion math', async () => {
    const eth = convertUsdToEth(100, 2500);
    assert.strictEqual(eth, '0.040000');

    const usd = convertEthToUsd(0.04, 2500);
    assert.strictEqual(usd, '100.00');
  });

  // 3. Connection Manager Provider caching & Keep-Alive
  await test('ConnectionManager: createEthersProvider caches and configures persistent agents', async () => {
    const p1 = connectionManager.createEthersProvider('https://rpc.mainnet.chain.robinhood.com', 4663);
    const p2 = connectionManager.createEthersProvider('https://rpc.mainnet.chain.robinhood.com', 4663);
    assert.strictEqual(p1, p2, 'Provider should be cached by URL:chainId');
    assert(connectionManager.httpsAgent !== null, 'Keep-Alive agent must exist');
  });

  // 4. WalletService empty balance safety
  await test('WalletService: checkBalances handles empty array safely', async () => {
    const dummyProvider = connectionManager.createEthersProvider('https://rpc.mainnet.chain.robinhood.com', 4663);
    const res = await WalletService.checkBalances([], dummyProvider);
    assert.deepStrictEqual(res, []);
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
