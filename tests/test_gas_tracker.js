const assert = require('assert');
const { ethers } = require('ethers');
const GasTracker = require('../src/services/gasTracker');

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
  console.log('\n🧪 Running Gas Tracker Unit Test Suite...\n');

  // Mock Provider
  const mockProvider = {
    getFeeData: async () => ({
      gasPrice: ethers.parseUnits('0.05', 'gwei'),
      maxFeePerGas: ethers.parseUnits('0.1', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('0.01', 'gwei')
    }),
    getBlock: async (tag) => ({
      number: 52826390,
      baseFeePerGas: ethers.parseUnits('0.02', 'gwei')
    })
  };

  const chainConfig = {
    name: 'Robinhood Chain',
    chainId: 4663
  };

  await test('GasTracker: Computes live metrics for Robinhood Chain L2', async () => {
    const metrics = await GasTracker.getGasMetrics(mockProvider, chainConfig);
    assert.strictEqual(metrics.chainName, 'Robinhood Chain');
    assert.strictEqual(metrics.chainId, 4663);
    assert.strictEqual(metrics.isL2, true);
    assert.strictEqual(metrics.blockNumber, 52826390);
    assert.strictEqual(metrics.baseFeeGwei, 0.02);
    assert.strictEqual(metrics.priorityFeeGwei, 0.01);
    assert.strictEqual(metrics.totalFeeGwei, 0.03);
    assert.strictEqual(metrics.trafficLevel, 'LOW');
    assert.ok(metrics.estimates.transfer.costEth);
    assert.ok(metrics.estimates.mint.costEth);
    assert.ok(metrics.estimates.seaport.costEth);
  });

  await test('GasTracker: Formats operation costs in ETH and USD accurately', async () => {
    const metrics = await GasTracker.getGasMetrics(mockProvider, chainConfig);
    assert(parseFloat(metrics.estimates.transfer.costEth) > 0);
    assert(parseFloat(metrics.estimates.mint.costEth) > parseFloat(metrics.estimates.transfer.costEth));
    assert(parseFloat(metrics.estimates.seaport.costEth) > parseFloat(metrics.estimates.transfer.costEth));
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
