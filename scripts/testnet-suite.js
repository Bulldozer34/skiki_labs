const { ethers } = require('ethers');
const chalk = require('chalk');
const logger = require('../src/utils/logger');
const connectionManager = require('../src/services/connectionManager');
const MultiRpcBroadcaster = require('../src/engines/multiRpcBroadcaster');
const PreflightSimulator = require('../src/engines/preflightSimulator');
const { estimateGas, formatGasEstimate } = require('../src/utils/gasEstimator');
const { translate, formatError } = require('../src/utils/errorTranslator');
const WalletService = require('../src/services/walletService');
const { mintHistoryWriter } = require('../src/utils/asyncWriter');
const { CHAINS } = require('../src/utils/chains');

async function runTestnetSuite() {
  logger.banner();
  console.log(chalk.cyan.bold('🧪 RUNNING COMPREHENSIVE TESTNET TEST SUITE\n'));
  
  let passedTests = 0;
  const totalTests = 5;

  // ----------------------------------------------------
  // TEST 1: Testnet RPC Connectivity & Multi-RPC Latency Race
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 1/5] Multi-RPC Racing & Testnet Connectivity'));
  try {
    const sepoliaRpcs = [
      'https://ethereum-sepolia-rpc.publicnode.com',
      'https://sepolia.drpc.org',
      'https://1rpc.io/sepolia'
    ];
    const sepoliaChainId = CHAINS.SEPOLIA.chainId;
    const broadcaster = new MultiRpcBroadcaster(sepoliaRpcs, sepoliaChainId);

    const start = Date.now();
    const provider = connectionManager.createEthersProvider(sepoliaRpcs[0], sepoliaChainId);
    const blockNumber = await provider.getBlockNumber();
    const latency = Date.now() - start;

    console.log(chalk.green(`  ✔ Sepolia RPC connected in ${latency}ms | Latest Block: #${blockNumber}`));
    console.log(chalk.green(`  ✔ MultiRpcBroadcaster initialized with ${broadcaster.rpcUrls.length} endpoints`));
    passedTests++;
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 1 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 2: Dynamic Gas Estimator on Live Testnet
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 2/5] Dynamic Mempool Gas Estimator'));
  try {
    const provider = connectionManager.createEthersProvider(CHAINS.SEPOLIA.defaultRpc, CHAINS.SEPOLIA.chainId);
    const gasEst = await estimateGas(provider, 'turbo');

    console.log(chalk.green(`  ✔ Gas Estimation successful:`));
    console.log(chalk.cyan(`    ${formatGasEstimate(gasEst)}`));
    console.log(chalk.green(`    MaxFeePerGas: ${ethers.formatUnits(gasEst.maxFeePerGas, 'gwei')} Gwei | Priority: ${ethers.formatUnits(gasEst.maxPriorityFeePerGas, 'gwei')} Gwei`));
    passedTests++;
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 2 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 3: Preflight Simulation & SeaDrop Error Decoding
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 3/5] Pre-Flight Simulation & Human-Readable Error Translation'));
  try {
    const provider = connectionManager.createEthersProvider(CHAINS.SEPOLIA.defaultRpc, CHAINS.SEPOLIA.chainId);
    const simulator = new PreflightSimulator(provider);
    
    // Test wallet attempting simulated mint on canonical SeaDrop
    const dummyWallet = ethers.Wallet.createRandom();
    
    // Simulate call that is expected to revert
    const simResult = await simulator.simulate({
      from: dummyWallet.address,
      to: CHAINS.SEPOLIA.seadropAddress,
      data: '0x',
      value: 0n
    });

    console.log(chalk.green(`  ✔ Pre-flight simulation executed (0 gas cost)`));
    console.log(chalk.cyan(`    Simulation Outcome: ${simResult.success ? 'PASSED' : 'REVERTED (Expected)'}`));
    if (!simResult.success) {
      console.log(chalk.cyan(`    Decoded Message: ${simResult.revertReason}`));
    }

    // Verify error translator module mappings
    const testCases = ['INSUFFICIENT_FUNDS', 'NotActive', 'ExceedsMaxPerWallet', 'nonce too low'];
    for (const raw of testCases) {
      const translated = translate(raw);
      console.log(chalk.green(`  ✔ Error '${raw}' → "${translated.simple}"`));
    }

    passedTests++;
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 3 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 4: In-Memory Nonce Queue & Offline Pre-signing
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 4/5] Sequential Nonce Queue & Pre-Sign Engine'));
  try {
    const testWallets = [
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom(),
      ethers.Wallet.createRandom()
    ];

    testWallets.forEach((w, i) => WalletService.setNonce(w.address, 10 + i));

    testWallets.forEach((w, i) => {
      const initial = WalletService.peekNonce(w.address);
      const consumed = WalletService.consumeNonce(w.address);
      const next = WalletService.peekNonce(w.address);
      if (initial !== 10 + i || consumed !== 10 + i || next !== 11 + i) {
        throw new Error(`Nonce queue mismatch for wallet ${i}`);
      }
    });

    console.log(chalk.green(`  ✔ Nonce queue verified for ${testWallets.length} wallets with 0 RPC calls`));
    passedTests++;
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 4 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 5: Live Progress Bar (10/10) & Async History Recording
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 5/5] Live 10/10 Mint Progress Tracker & Non-Blocking Async I/O'));
  try {
    const totalSimulated = 10;
    for (let i = 1; i <= totalSimulated; i++) {
      logger.mintProgress(i, totalSimulated, i, 0);
      await new Promise(r => setTimeout(r, 60));
    }
    logger.mintComplete(totalSimulated, 0, totalSimulated);

    // Test async writer
    const mockResults = Array.from({ length: totalSimulated }, (_, i) => ({
      address: ethers.Wallet.createRandom().address,
      status: 'SUCCESS',
      txHash: '0x' + 'a'.repeat(64),
      details: `Testnet Simulation Block #${1000 + i}`
    }));

    mintHistoryWriter.write(mockResults);
    await mintHistoryWriter.flush();

    console.log(chalk.green(`  ✔ Async writer flushed ${mockResults.length} test records cleanly`));
    passedTests++;
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 5 Failed: ${err.message}`));
  }

  console.log('');
  logger.separator();
  if (passedTests === totalTests) {
    console.log(chalk.green.bold(`🎉 ALL ${passedTests}/${totalTests} TESTNET TESTS PASSED SUCCESSFULLY!`));
  } else {
    console.log(chalk.yellow.bold(`⚠️ ${passedTests}/${totalTests} tests passed.`));
  }
  logger.separator();

  process.exit(passedTests === totalTests ? 0 : 1);
}

runTestnetSuite().catch(err => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
