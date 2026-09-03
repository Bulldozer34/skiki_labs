const assert = require('assert');
const dropTracker = require('../src/services/dropTrackerService');
const trackedWalletService = require('../src/services/trackedWalletService');
const PnLCardGenerator = require('../src/utils/pnlCardGenerator');
const copyMintPnL = require('../src/services/copyMintPnL');

let passedTests = 0;
let failedTests = 0;

function syncTest(name, fn) {
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

console.log('\n🧪 Running Drop Tracker & Enhanced Features Test Suite...\n');

(async () => {
  // 1. Slug extraction
  syncTest('DropTracker: Extract slug from various OpenSea URL formats', () => {
    assert.strictEqual(dropTracker.extractSlug('https://opensea.io/collection/echo-rh/drop'), 'echo-rh');
    assert.strictEqual(dropTracker.extractSlug('https://opensea.io/collection/cyber-apes-rh'), 'cyber-apes-rh');
    assert.strictEqual(dropTracker.extractSlug('https://opensea.io/collection/Test_Slug-123/'), 'test_slug-123');
    assert.strictEqual(dropTracker.extractSlug('cool-cats'), 'cool-cats');
  });

  // 2. Tracked Wallets env export
  syncTest('TrackedWalletService: exportEnvString formats correctly for Render', () => {
    const original = [...trackedWalletService.wallets];
    trackedWalletService.wallets = [
      { address: '0x460d7DFa923C363d6b8F421D599Aee1648a73bEE', label: 'Whale Alpha' },
      { address: '0xb9db0103db118a655057bc3d882639771074d7b4', label: 'Whale Beta' }
    ];

    const envStr = trackedWalletService.exportEnvString();
    assert.ok(envStr.includes('0x460d7DFa923C363d6b8F421D599Aee1648a73bEE:Whale_Alpha'));
    assert.ok(envStr.includes('0xb9db0103db118a655057bc3d882639771074d7b4:Whale_Beta'));

    // Restore
    trackedWalletService.wallets = original;
  });

  // 3. QuickChart URL Generation
  syncTest('PnLCardGenerator: generateQuickChartCardUrl creates valid chart URL on 0-state', () => {
    const summary = {
      netProfitUsd: 0,
      totalMinted: 0,
      totalSold: 0,
      holdingCount: 0,
      roiPct: 0,
      topCollections: []
    };

    const url = PnLCardGenerator.generateQuickChartCardUrl(summary);
    assert.ok(url.startsWith('https://quickchart.io/chart?bkg='));
    assert.ok(url.includes('Clean%20Slate') || url.includes('Robinhood%20Portfolio'));
  });

  // 4. Per-collection PnL filtering
  await asyncTest('CopyMintPnL: getSummary filters by contract or slug', async () => {
    const original = [...copyMintPnL.records];
    copyMintPnL.records = [
      {
        contractAddress: '0x1111111111111111111111111111111111111111',
        collectionName: 'Collection Alpha',
        collectionSlug: 'alpha-slug',
        whaleWallet: '0x460d7DFa923C363d6b8F421D599Aee1648a73bEE',
        whaleLabel: 'Whale 1',
        totalNftsMinted: 5,
        soldCount: 5,
        totalCostEth: 0.001,
        realizedRevenueEth: 0.005,
        floorPriceEth: 0.001
      },
      {
        contractAddress: '0x2222222222222222222222222222222222222222',
        collectionName: 'Collection Beta',
        collectionSlug: 'beta-slug',
        whaleWallet: '0xb9db0103db118a655057bc3d882639771074d7b4',
        whaleLabel: 'Whale 2',
        totalNftsMinted: 10,
        soldCount: 0,
        totalCostEth: 0.002,
        realizedRevenueEth: 0,
        floorPriceEth: 0.001
      }
    ];

    const alphaSummary = await copyMintPnL.getSummary('alpha-slug');
    assert.strictEqual(alphaSummary.totalDrops, 1);
    assert.strictEqual(alphaSummary.totalMinted, 5);
    assert.strictEqual(alphaSummary.totalSold, 5);

    const betaSummary = await copyMintPnL.getSummary('0x2222222222222222222222222222222222222222');
    assert.strictEqual(betaSummary.totalDrops, 1);
    assert.strictEqual(betaSummary.totalMinted, 10);
    assert.strictEqual(betaSummary.totalSold, 0);

    // Restore clean state
    copyMintPnL.records = original;
    copyMintPnL._save();
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  }
})();
