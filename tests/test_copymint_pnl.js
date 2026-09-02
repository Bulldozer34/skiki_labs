/**
 * Test Suite — Copy-Mint PnL Service & Visual Card Generator.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const copyMintPnL = require('../src/services/copyMintPnL');
const PnLCardGenerator = require('../src/utils/pnlCardGenerator');

let passedTests = 0;
let failedTests = 0;

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

console.log('\n🧪 Running Copy-Mint PnL & Card Generator Test Suite...\n');

// Preserve original records so tests never pollute real portfolio data
const originalRecords = [...copyMintPnL.records];

(async () => {
  // 1. Record a copy-mint
  await asyncTest('CopyMintPnL: Record copy-mint event and calculate costs', async () => {
    const event = {
      targetContract: '0x1234567890abcdef1234567890abcdef12345678',
      collectionName: 'OEGP Genesis Collection',
      collectionSlug: 'oegp-genesis',
      collectionImage: 'https://opensea.io/static/images/logos/opensea-logo.png',
      whaleWallet: '0x460d7DFa923C363d6b8F421D599Aee1648a73bEE',
      whaleLabel: 'OEGP Whale Alpha',
      mintPriceEth: '0', // Free mint
      totalNftsMinted: 10,
      walletCount: 5,
      gasSpentEth: '0.0005'
    };

    const record = await copyMintPnL.recordCopyMint(event);
    assert.strictEqual(record.collectionName, 'OEGP Genesis Collection');
    assert.strictEqual(record.totalNftsMinted, 10);
    assert.strictEqual(record.mintPriceEthPerToken, 0);
    assert.strictEqual(record.gasSpentEth, 0.0005);
  });

  // 2. Record secondary sale
  await asyncTest('CopyMintPnL: Record secondary sale and realized revenue', async () => {
    const sale = await copyMintPnL.recordSale(
      '0x1234567890abcdef1234567890abcdef12345678',
      6, // Sold 6 NFTs
      0.004 // At 0.004 ETH each
    );

    assert.ok(sale, 'Sale record must be updated');
    assert.strictEqual(sale.soldCount >= 6, true);
    assert.strictEqual(sale.realizedRevenueEth >= 0.024, true);
  });

  // 3. Compute Summary & PnL
  await asyncTest('CopyMintPnL: Compute summary analytics and net profit', async () => {
    const summary = await copyMintPnL.getSummary();
    assert.ok(summary.totalMinted >= 10);
    assert.ok(summary.totalSold >= 6);
    assert.ok(summary.holdingCount >= 4);
    assert.strictEqual(typeof summary.netProfitUsd, 'number');
    assert.strictEqual(typeof summary.roiPct, 'number');
    assert.ok(summary.topCollections.length > 0);
  });

  // 4. Generate SVG Card
  await asyncTest('PnLCardGenerator: Generate 1200x675 SVG card with valid markup', async () => {
    const summary = await copyMintPnL.getSummary();
    const svgCode = PnLCardGenerator.generateSvgCard(summary);

    assert.ok(svgCode.includes('<svg width="1200" height="675"'), 'SVG must have 1200x675 resolution');
    assert.ok(svgCode.includes('Profit'), 'SVG must include Profit headline');
    assert.ok(svgCode.includes('OEGP Genesis Collection'), 'SVG must include collection name');

    const testPath = path.join(process.cwd(), 'data', 'test_pnl.svg');
    const savedPath = PnLCardGenerator.saveSvgCardToFile(summary, testPath);
    assert.ok(fs.existsSync(savedPath), 'SVG file must be written to disk');

    if (fs.existsSync(testPath)) {
      fs.unlinkSync(testPath);
    }
  });

  // 5. Format Telegram Message
  await asyncTest('PnLCardGenerator: Format rich HTML message for Telegram', async () => {
    const summary = await copyMintPnL.getSummary();
    const msg = PnLCardGenerator.formatTelegramMessage(summary);

    assert.ok(msg.includes('COPY-MINT PnL &amp; PERFORMANCE REPORT') || msg.includes('COPY-MINT PnL & PERFORMANCE REPORT'));
    assert.ok(msg.includes('Total Minted:'));
    assert.ok(msg.includes('Total Sold:'));
  });

  // Restore clean original records
  copyMintPnL.records = originalRecords;
  copyMintPnL._save();

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  }
})();
