const axios = require('axios');
const { ethers } = require('ethers');
const fs = require('fs');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const authService = require('../services/authService');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const { estimateGas, formatGasEstimate } = require('../utils/gasEstimator');

/**
 * Build a sanitized batched GraphQL query with field aliases (SEC-02 Fix)
 */
function buildBatchQuery(wallets, config) {
  const { chain, quantity, nftContractAddress } = config;
  
  // 1. Strict address validation
  if (!ethers.isAddress(nftContractAddress)) {
    throw new Error(`Invalid NFT contract address format: ${nftContractAddress}`);
  }

  // 2. Strict chain identifier allowlist
  const rawChain = (typeof chain === 'string' ? chain : (chain.name || 'BASE')).toUpperCase();
  const ALLOWED_CHAINS = new Set(['ETHEREUM', 'BASE', 'ARBITRUM', 'OPTIMISM', 'ROBINHOOD']);
  const chainIdentifier = ALLOWED_CHAINS.has(rawChain) ? rawChain : 'BASE';

  // 3. Strict integer quantity and checksummed address
  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const safeContract = ethers.getAddress(nftContractAddress).toLowerCase();

  let query = 'query B {\n';
  wallets.forEach((w, i) => {
    const safeAddress = ethers.getAddress(w.address).toLowerCase();
    query += `  w${i}: swap(
    chain: ${chainIdentifier}
    address: "${safeAddress}"
    action: MINT
    quantity: ${safeQuantity}
    contractAddress: "${safeContract}"
  ) {
    ... on SwapActionTransaction {
      transactionSubmissionData {
        chainIdentifier
        to
        value
        data
      }
    }
    ... on SwapActionError {
      __typename
      message
    }
  }\n`;
  });
  query += '}';
  return query;
}

/**
 * Fetch calldata in a single HTTP POST using GraphQL field aliasing
 */
async function fetchBatchCalldata(wallets, config, authHeaders) {
  const query = buildBatchQuery(wallets, config);
  const gqlUrl = process.env.OPENSEA_GQL_URL || 'https://gql.opensea.io/graphql/';

  const response = await connectionManager.axiosInstance.post(gqlUrl, { query }, {
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json'
    },
    timeout: 8000
  });

  const json = response.data;
  const calldataMap = new Map();

  if (json.errors) {
    logger.warn(`GraphQL Batch Notice: ${JSON.stringify(json.errors[0]?.message || json.errors)}`);
  }

  if (json.data) {
    wallets.forEach((w, i) => {
      const result = json.data[`w${i}`];
      if (result && result.transactionSubmissionData) {
        calldataMap.set(w.address.toLowerCase(), result.transactionSubmissionData);
      } else if (result && result.__typename === 'SwapActionError') {
        logger.warn(`[${w.address.slice(0, 6)}...] Swap: ${result.message}`);
      }
    });
  }

  return calldataMap;
}

/**
 * Fallback to fetch single calldata per wallet if batch aliasing is rejected
 */
async function fetchSingleCalldata(wallet, config, authHeaders) {
  const { chain, quantity, nftContractAddress } = config;
  const chainIdentifier = (typeof chain === 'string' ? chain : (chain.name || 'BASE')).toUpperCase();
  const gqlUrl = process.env.OPENSEA_GQL_URL || 'https://gql.opensea.io/graphql/';

  const query = `
    query MintActionTimelineQuery($chain: ChainScalar!, $address: AddressScalar!, $action: ActionType!, $quantity: Int!, $nftContractAddress: AddressScalar!) {
      swap(
        chain: $chain
        address: $address
        action: $action
        quantity: $quantity
        contractAddress: $nftContractAddress
      ) {
        ... on SwapActionTransaction {
          transactionSubmissionData {
            chainIdentifier
            to
            value
            data
          }
        }
        ... on SwapActionError {
          __typename
          message
        }
      }
    }
  `;

  const variables = {
    chain: chainIdentifier,
    address: ethers.getAddress(wallet.address).toLowerCase(),
    action: 'MINT',
    quantity: Math.max(1, Math.floor(Number(quantity) || 1)),
    nftContractAddress: ethers.getAddress(nftContractAddress).toLowerCase()
  };

  const res = await connectionManager.axiosInstance.post(gqlUrl, { query, variables }, {
    headers: { ...authHeaders, 'Content-Type': 'application/json' },
    timeout: 8000
  });

  const swap = res.data?.data?.swap;
  if (swap && swap.transactionSubmissionData) {
    return swap.transactionSubmissionData;
  }
  return null;
}

/**
 * Main Allowlist / FCFS Mint Runner with Multi-RPC Broadcast
 */
async function runAllowlistMint(config) {
  const { wallets, provider, rpcUrls, nftContractAddress, chain, quantity, gasSettings, recipientAddress } = config;
  let { startTime } = config;

  const explorerUrl = chain.explorerUrl || 'https://etherscan.io';

  logger.separator();
  logger.info(`Mode: OpenSea Allowlist / FCFS (Signed Mint)`);
  logger.info(`NFT Contract: ${nftContractAddress}`);
  logger.info(`Wallets Count: ${wallets.length}`);
  logger.info(`Quantity per Wallet: ${quantity}`);
  logger.separator();

  // 1. Authenticate all wallets with SIWE
  logger.info('Authenticating wallets with OpenSea SIWE...');
  await authService.authenticateAll(wallets);
  
  const authHeaders = authService.getAuthHeaders(wallets[0].address);
  if (!authHeaders) {
    throw new Error('Failed to obtain OpenSea session headers.');
  }

  // Initialize Multi-RPC Broadcaster & Simulator
  const network = await provider.getNetwork();
  const broadcaster = new MultiRpcBroadcaster(rpcUrls || [provider._getConnection ? provider._getConnection().url : config.rpcUrl], Number(network.chainId));
  const simulator = new PreflightSimulator(provider);

  // Pre-fetch nonces
  let nonceMap = new Map();
  for (const w of wallets) {
    const n = await provider.getTransactionCount(w.address, 'pending');
    nonceMap.set(w.address.toLowerCase(), n);
  }

  const now = Math.floor(Date.now() / 1000);
  let calldataMap = new Map();

  // 2. Pre-mint warmup & scheduling
  if (startTime && startTime > now) {
    const secondsRemaining = startTime - now;
    logger.timer(`Allowlist mint scheduled for ${new Date(startTime * 1000).toLocaleTimeString()} (in ${secondsRemaining}s)`);

    // T-10s: Pre-fetch nonces
    if (secondsRemaining > 10) {
      await logger.countdown(secondsRemaining - 10);
      logger.info('T-10s: Refreshing wallet nonces...');
      for (const w of wallets) {
        try {
          const n = await provider.getTransactionCount(w.address, 'pending');
          nonceMap.set(w.address.toLowerCase(), n);
        } catch (e) {}
      }

      // T-5s: Connection warming across GraphQL and all RPCs
      logger.info('T-5s: Pre-warming socket pool across OpenSea and RPC endpoints...');
      await connectionManager.preWarmSockets(['https://gql.opensea.io/graphql/', ...broadcaster.rpcUrls]);
      await logger.countdown(3.5);

      // T-1.5s: Parallel Hammering OpenSea GraphQL with backoff for early calldata
      logger.speed('T-1.5s: Hammering OpenSea GraphQL for allowlist calldata & signatures...');
      const hammerStart = Date.now();
      let retryDelay = 100;
      while (Date.now() - hammerStart < 4000) {
        try {
          calldataMap = await fetchBatchCalldata(wallets, config, authHeaders);
          if (calldataMap.size > 0) {
            logger.success(`Early calldata acquired for ${calldataMap.size} wallet(s)!`);
            break;
          }
        } catch (err) {
          // Keep hammering with bounded jitter backoff
          retryDelay = Math.min(250, retryDelay + 25);
        }
        await new Promise(r => setTimeout(r, retryDelay));
      }
    } else {
      await logger.countdown(secondsRemaining);
    }
  }

  // 3. Final calldata fetch if not already acquired
  if (calldataMap.size === 0) {
    logger.info('Fetching mint calldata via GraphQL batch...');
    try {
      calldataMap = await fetchBatchCalldata(wallets, config, authHeaders);
    } catch (err) {
      logger.warn(`Batch query error (${err.message}). Falling back to individual requests...`);
      await Promise.allSettled(wallets.map(async (w) => {
        try {
          const headers = authService.getAuthHeaders(w.address) || authHeaders;
          const data = await fetchSingleCalldata(w, config, headers);
          if (data) calldataMap.set(w.address.toLowerCase(), data);
        } catch (e) {}
      }));
    }
  }

  logger.info(`Valid calldata acquired for ${calldataMap.size}/${wallets.length} wallet(s).`);

  if (calldataMap.size === 0) {
    throw new Error('Could not obtain calldata for any wallet. Mint may not be live or wallets not eligible.');
  }

  // 4. Pre-flight simulation on first valid calldata
  const firstWalletAddr = Array.from(calldataMap.keys())[0];
  const firstCalldata = calldataMap.get(firstWalletAddr);
  if (firstCalldata) {
    const sim = await simulator.simulate({
      from: firstWalletAddr,
      to: firstCalldata.to,
      data: firstCalldata.data,
      value: firstCalldata.value ? BigInt(firstCalldata.value) : 0n
    });
    if (!sim.success) {
      logger.warn(`Simulation check: ${sim.revertReason}`);
    } else {
      logger.success('Pre-flight simulation successful (0 gas cost).');
    }
  }

  // Dynamic Gas Estimation (live mempool pricing)
  let maxFeePerGasWei = ethers.parseUnits((gasSettings.maxFeePerGas || '25.0').toString(), 'gwei');
  let maxPriorityFeePerGasWei = ethers.parseUnits((gasSettings.maxPriorityFeePerGas || '1.5').toString(), 'gwei');

  try {
    const gasEst = await estimateGas(provider, 'turbo');
    if (gasEst) {
      maxFeePerGasWei = gasEst.maxFeePerGas;
      maxPriorityFeePerGasWei = gasEst.maxPriorityFeePerGas;
      logger.gasEstimate(formatGasEstimate(gasEst));
    }
  } catch (e) {
    // Fall back to config gas
  }

  // 5. Pre-sign and Parallel Multi-RPC Broadcast
  logger.speed(`>>> FIRE! Broadcasting across ${broadcaster.rpcUrls.length} RPC node(s) <<<`);
  const startTimeMs = Date.now();
  const totalWallets = wallets.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const txPromises = wallets.map(async (wallet) => {
    const calldata = calldataMap.get(wallet.address.toLowerCase());
    if (!calldata) {
      completedCount++;
      failCount++;
      logger.mintProgress(completedCount, totalWallets, successCount, failCount);
      return {
        address: wallet.address,
        status: 'SKIPPED',
        txHash: null,
        details: 'Not eligible / No calldata'
      };
    }

    try {
      const nonce = nonceMap.get(wallet.address.toLowerCase()) ?? await provider.getTransactionCount(wallet.address, 'pending');

      const tx = {
        to: calldata.to,
        data: calldata.data,
        value: calldata.value ? BigInt(calldata.value) : 0n,
        gasLimit: parseInt(gasSettings.gasLimit) || 300000,
        maxFeePerGas: maxFeePerGasWei,
        maxPriorityFeePerGas: maxPriorityFeePerGasWei,
        nonce: nonce,
        chainId: network.chainId,
        type: 2
      };

      const signedTx = await wallet.signTransaction(tx);
      const broadcastResult = await broadcaster.broadcastFastest(signedTx);
      logger.walletLine(wallet.address, 'Sent', `Fastest: ${broadcastResult.fastestRpc} (${broadcastResult.durationMs}ms)`);

      const { receipt } = await broadcaster.waitForReceiptFastest(broadcastResult.txHash, 1, 60000);
      const latencyMs = Date.now() - startTimeMs;

      if (receipt && receipt.status === 1) {
        completedCount++;
        successCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        logger.walletLine(wallet.address, 'SUCCESS', `Block #${receipt.blockNumber} (${latencyMs}ms)`);

        Notifier.sendMintAlert({
          address: wallet.address,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          explorerUrl,
          contractAddress: nftContractAddress,
          latencyMs,
          blockNumber: receipt.blockNumber
        });

        // Do not return raw wallet object to prevent serialization (SEC-01)
        return {
          address: wallet.address,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          receipt,
          details: `Block ${receipt.blockNumber} (${latencyMs}ms)`
        };
      } else {
        completedCount++;
        failCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        logger.walletLine(wallet.address, 'FAILED', 'Transaction reverted on-chain');

        Notifier.sendMintAlert({
          address: wallet.address,
          status: 'FAILED',
          txHash: broadcastResult.txHash,
          explorerUrl,
          contractAddress: nftContractAddress,
          error: 'Transaction reverted on-chain'
        });

        return {
          address: wallet.address,
          status: 'FAILED',
          txHash: broadcastResult.txHash,
          receipt,
          details: 'Reverted on-chain'
        };
      }
    } catch (error) {
      completedCount++;
      failCount++;
      logger.mintProgress(completedCount, totalWallets, successCount, failCount);

      const friendlyMsg = formatError(error);
      logger.walletLine(wallet.address, 'ERROR', friendlyMsg);
      logger.warn(`  Technical detail: ${error.message}`);

      Notifier.sendMintAlert({
        address: wallet.address,
        status: 'FAILED',
        txHash: null,
        explorerUrl,
        contractAddress: nftContractAddress,
        error: friendlyMsg
      });

      return {
        address: wallet.address,
        status: 'FAILED',
        txHash: null,
        details: friendlyMsg
      };
    }
  });

  const rawResults = await Promise.allSettled(txPromises);
  const results = rawResults.map(r => r.value || { address: 'Unknown', status: 'FAILED', details: r.reason?.message });

  // Print Mint Complete Status (e.g. 10/10 minted) and Summary Table
  logger.mintComplete(successCount, failCount, totalWallets);
  logger.summaryTable(results);

  // 6. Auto-forward NFTs if recipient configured
  const successfulResults = results.filter(r => r.status === 'SUCCESS' && r.receipt);
  if (recipientAddress && successfulResults.length > 0) {
    await forwardNFTs(successfulResults, wallets, provider, recipientAddress, explorerUrl);
  }

  // Non-blocking async history recording (SEC-01)
  try {
    mintHistoryWriter.write(results);
    await mintHistoryWriter.flush();
  } catch (e) {}

  return results;
}

module.exports = { runAllowlistMint };
