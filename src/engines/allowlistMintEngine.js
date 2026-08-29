const { ethers } = require('ethers');
const { getChainKey } = require('../utils/chains');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const authService = require('../services/authService');
const WalletService = require('../services/walletService');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const { resolveGasFees, formatGasSelection } = require('../utils/gasEstimator');

function getOpenSeaApiKey() {
  return (process.env.OPENSEA_API_KEY || process.env.OPENSEA_KEY || '').trim();
}

function getDropSlug(config) {
  return (config.collectionSlug || config.slug || config.nftContractAddress || '').trim();
}

function normalizeTxValue(value) {
  if (value == null || value === '') return '0';
  return typeof value === 'number' ? String(value) : value;
}

function normalizeOpenSeaMintTransaction(payload) {
  const candidates = [
    payload,
    payload?.transaction,
    payload?.transactionData,
    payload?.transaction_data,
    payload?.transactionSubmissionData,
    payload?.data,
    payload?.data?.transaction,
    payload?.data?.transactionData,
    payload?.data?.transaction_data,
    payload?.data?.transactionSubmissionData
  ];

  const tx = candidates.find(item => item && item.to && item.data);
  if (!tx) {
    throw new Error(`OpenSea mint response did not include transaction data: ${JSON.stringify(payload).slice(0, 500)}`);
  }

  return {
    chainIdentifier: tx.chainIdentifier || tx.chain || payload?.chainIdentifier || payload?.chain || null,
    to: tx.to,
    value: normalizeTxValue(tx.value),
    data: tx.data
  };
}

/**
 * Fetch ready-to-sign mint transaction data from OpenSea Drops REST API (v2)
 */
async function fetchSingleCalldata(wallet, config, authHeaders, requestTimeout = 8000) {
  const { quantity } = config;
  const apiKey = getOpenSeaApiKey();
  const slug = getDropSlug(config);

  if (!slug) {
    throw new Error('Collection identifier is required to fetch drop mint data.');
  }

  const safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
  const baseUrl = (process.env.OPENSEA_API_URL || 'https://api.opensea.io').replace(/\/+$/, '');
  const url = `${baseUrl}/api/v2/drops/${encodeURIComponent(slug)}/mint`;

  const headers = {
    'accept': 'application/json',
    'content-type': 'application/json',
    ...(authHeaders || {})
  };

  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }

  const res = await connectionManager.axiosInstance.post(url, {
    minter: ethers.getAddress(wallet.address),
    quantity: safeQuantity
  }, {
    headers,
    timeout: requestTimeout
  });

  return normalizeOpenSeaMintTransaction(res.data);
}

/**
 * Fetch calldata concurrently for all session wallets
 */
async function fetchAllCalldata(wallets, config, authHeadersByAddress, fallbackAuthHeaders, requestTimeout = 8000) {
  const calldataMap = new Map();

  const settled = await Promise.allSettled(wallets.map(async (wallet) => {
    try {
      const headers = authHeadersByAddress.get(wallet.address.toLowerCase()) || fallbackAuthHeaders;
      const data = await fetchSingleCalldata(wallet, config, headers, requestTimeout);
      return { wallet, data, error: null };
    } catch (error) {
      const apiMessage = error.response?.data?.message || error.response?.data?.detail || error.response?.data?.error;
      const status = error.response?.status ? `HTTP ${error.response.status}: ` : '';
      return { wallet, data: null, error: `${status}${apiMessage || error.message}` };
    }
  }));

  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;

    const { wallet, data, error } = result.value;
    if (data) {
      calldataMap.set(wallet.address.toLowerCase(), data);
    } else if (error) {
      logger.warn(`[${wallet.address.slice(0, 6)}...] Calldata fetch: ${error}`);
    }
  }

  return calldataMap;
}

/**
 * Main Allowlist / FCFS Mint Runner with Multi-RPC Broadcast
 */
async function runAllowlistMint(config) {
  const { wallets, provider, rpcUrls, nftContractAddress, chain, quantity, gasSettings, recipientAddress } = config;
  let { startTime } = config;

  const explorerUrl = chain?.explorerUrl || 'https://etherscan.io';
  const chainKey = getChainKey(chain);

  logger.separator();
  logger.info(`Mode: OpenSea Allowlist / FCFS (Signed Mint via Drops API)`);
  logger.info(`NFT Contract: ${nftContractAddress}`);
  logger.info(`Chain: ${chainKey}`);
  logger.info(`Wallets Count: ${wallets.length}`);
  logger.info(`Quantity per Wallet: ${quantity}`);
  logger.separator();

  // 1. Pre-warm sockets immediately across OpenSea API and all RPCs (non-blocking)
  const initialEndpoints = ['https://api.opensea.io', ...(rpcUrls || [config.rpcUrl])];
  connectionManager.preWarmSockets(initialEndpoints).catch(() => {});

  // Authenticate all wallets with SIWE
  logger.info('Authenticating wallets with OpenSea SIWE...');
  await authService.authenticateAll(wallets);

  const authHeadersByAddress = new Map();
  for (const wallet of wallets) {
    const headers = authService.getAuthHeaders(wallet.address);
    if (headers) {
      authHeadersByAddress.set(wallet.address.toLowerCase(), headers);
    }
  }

  const fallbackAuthHeaders = authHeadersByAddress.values().next().value || {};

  // Initialize Multi-RPC Broadcaster & Simulator
  const network = await provider.getNetwork();
  const broadcaster = new MultiRpcBroadcaster(rpcUrls || [provider._getConnection ? provider._getConnection().url : config.rpcUrl], Number(network.chainId));
  const simulator = new PreflightSimulator(provider);

  // Pre-fetch nonces
  let nonceMap = await WalletService.prefetchNonces(wallets, provider);

  let calldataMap = new Map();
  const deadlineMs = startTime ? startTime * 1000 : 0;

  // --- UNIFIED CONTINUOUS WARMUP PIPELINE ---
  if (deadlineMs > Date.now()) {
    const totalRemaining = Math.ceil((deadlineMs - Date.now()) / 1000);
    logger.timer(`Allowlist mint scheduled for ${new Date(deadlineMs).toLocaleTimeString()} (in ${logger.formatDuration(totalRemaining)})`);

    let didT15 = false;
    let didT5 = false;
    let didT3 = false;

    // Run unified continuous countdown until T-3s / drop start
    await new Promise(resolve => {
      let isBusy = false;

      const tick = async () => {
        if (isBusy) return;
        const remainingMs = deadlineMs - Date.now();

        // 1. T-15s: Nonce refresh
        if (remainingMs <= 15000 && !didT15) {
          didT15 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-15s: Refreshing nonces...]    \n`);
          try {
            logger.info('T-15s: Refreshing wallet nonces...');
            nonceMap = await WalletService.prefetchNonces(wallets, provider);
          } catch (e) {}
          isBusy = false;
        }

        // 2. T-5s: Socket pool pre-warm
        if (remainingMs <= 5000 && !didT5) {
          didT5 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-5s: Pre-warming sockets...]    \n`);
          try {
            logger.info('T-5s: Pre-warming sockets across OpenSea API and RPC endpoints...');
            await connectionManager.preWarmSockets(['https://api.opensea.io', ...broadcaster.rpcUrls]);
          } catch (e) {}
          isBusy = false;
        }

        // 3. T-3s: Calldata acquisition / Hammer phase
        if (remainingMs <= 3000 && !didT3) {
          didT3 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-3s: Calldata hammer...]    \n`);
          try {
            logger.speed('T-3s: Hammering OpenSea Drops API for calldata (1.5s timeout)...');
            const hammerEnd = deadlineMs + 2000;
            let hammerAttempt = 0;
            while (Date.now() < hammerEnd && calldataMap.size === 0) {
              hammerAttempt++;
              try {
                calldataMap = await fetchAllCalldata(wallets, config, authHeadersByAddress, fallbackAuthHeaders, 1500);
                if (calldataMap.size > 0) {
                  logger.success(`Early calldata acquired for ${calldataMap.size} wallet(s) on attempt #${hammerAttempt}!`);
                  break;
                }
              } catch (err) {}
              await new Promise(r => setTimeout(r, 100));
            }
            if (calldataMap.size === 0 && hammerAttempt > 0) {
              logger.warn(`Hammer phase: ${hammerAttempt} attempts, no calldata yet — will retry after deadline`);
            }
          } catch (e) {}
          isBusy = false;
        }

        if (remainingMs > 50) {
          const display = logger.formatDuration(remainingMs / 1000, true);
          process.stdout.write(`\r${chalk.blue('[timer]')} Drop starts in ${chalk.yellow(display)}...    `);
          setTimeout(tick, Math.min(Math.max(10, remainingMs - 50), remainingMs <= 10000 ? 100 : 1000));
        } else {
          process.stdout.write('\r\n');
          resolve();
        }
      };

      tick();
    });
  }

  // Final calldata fetch if not already acquired (full 8s timeout)
  if (calldataMap.size === 0) {
    logger.info('Fetching mint calldata via OpenSea Drops API...');
    calldataMap = await fetchAllCalldata(wallets, config, authHeadersByAddress, fallbackAuthHeaders);
  }

  logger.info(`Valid calldata acquired for ${calldataMap.size}/${wallets.length} wallet(s).`);

  if (calldataMap.size === 0) {
    logger.warn('Tip: If this is an OpenSea SeaDrop contract, select "Public Mint (Direct SeaDrop Contract)" mode to mint directly on-chain.');
    throw new Error('Could not obtain calldata for any wallet. Check drop live status, wallet eligibility, or use Direct SeaDrop Mint.');
  }

  // Pre-flight simulation on first valid calldata
  const firstWalletAddr = Array.from(calldataMap.keys())[0];
  const firstCalldata = calldataMap.get(firstWalletAddr);
  if (firstCalldata) {
    const sim = await simulator.simulate({
      from: firstWalletAddr,
      to: firstCalldata.to,
      data: firstCalldata.data,
      value: firstCalldata.value ? BigInt(firstCalldata.value) : 0n
    }, true);
    if (!sim.success) {
      logger.warn(`Simulation check: ${sim.revertReason}`);
    } else {
      logger.success('Pre-flight simulation passed.');
    }
  }

  const gasFees = await resolveGasFees(provider, gasSettings, 'turbo');
  const maxFeePerGasWei = gasFees.maxFeePerGas;
  const maxPriorityFeePerGasWei = gasFees.maxPriorityFeePerGas;
  logger.gasEstimate(formatGasSelection(gasFees));

  // Pre-sign transactions immediately
  logger.info('Pre-signing transactions offline...');
  const preparedTxs = await Promise.all(wallets.map(async (wallet) => {
    const calldata = calldataMap.get(wallet.address.toLowerCase());
    if (!calldata) {
      return { wallet, signedTx: null, rawTxObj: null, error: 'Not eligible / No calldata' };
    }

    try {
      const nonce = WalletService.consumeNonce(wallet.address)
        ?? nonceMap.get(wallet.address.toLowerCase())
        ?? await provider.getTransactionCount(wallet.address, 'pending');

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
      return { wallet, signedTx, rawTxObj: tx, error: null };
    } catch (err) {
      return { wallet, signedTx: null, rawTxObj: null, error: err.message };
    }
  }));

  // Re-warm sockets right before firing to ensure TCP/TLS is hot
  await connectionManager.preWarmSockets(broadcaster.rpcUrls);

  // 6. Pre-sign and Parallel Multi-RPC Broadcast
  logger.speed(`>>> FIRE! Broadcasting across ${broadcaster.rpcUrls.length} RPC node(s) <<<`);
  const startTimeMs = Date.now();
  const totalWallets = wallets.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const txPromises = preparedTxs.map(async ({ wallet, signedTx, rawTxObj, error }) => {
    if (!signedTx) {
      completedCount++;
      failCount++;
      logger.mintProgress(completedCount, totalWallets, successCount, failCount);
      return {
        timestamp: new Date().toISOString(),
        formattedTime: new Date().toLocaleString(),
        network: chainConfig?.name || network.name,
        contractAddress: nftContractAddress,
        walletAddress: wallet.address,
        maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
        mode: 'ALLOWLIST',
        quantity,
        status: 'SKIPPED',
        txHash: null,
        details: error || 'Not eligible / No calldata',
        revertReason: null
      };
    }

    const walletStartMs = Date.now();
    try {
      const broadcastResult = await broadcaster.broadcastFastest(signedTx);
      logger.walletLine(wallet.address, 'Sent', `Fastest: ${broadcastResult.fastestRpc} (${broadcastResult.durationMs}ms)`);

      const { receipt } = await broadcaster.waitForReceiptFastest(broadcastResult.txHash, 1, 60000);
      const mintDurationMs = Date.now() - walletStartMs;
      const latencyMs = Date.now() - startTimeMs;

      if (receipt && receipt.status === 1) {
        completedCount++;
        successCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        logger.walletLine(wallet.address, 'SUCCESS', `Block #${receipt.blockNumber} (${mintDurationMs}ms)`);

        Notifier.sendMintAlert({
          address: wallet.address,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          explorerUrl,
          contractAddress: nftContractAddress,
          latencyMs,
          blockNumber: receipt.blockNumber
        });

        return {
          timestamp: new Date().toISOString(),
          formattedTime: new Date().toLocaleString(),
          network: chainConfig?.name || network.name,
          contractAddress: nftContractAddress,
          walletAddress: wallet.address,
          maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
          mode: 'ALLOWLIST',
          quantity,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          blockNumber: receipt.blockNumber ? Number(receipt.blockNumber) : null,
          gasUsed: receipt.gasUsed ? receipt.gasUsed.toString() : null,
          gasPriceGwei: receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') : null,
          mintDurationMs,
          details: `Block #${receipt.blockNumber} (${mintDurationMs}ms)`,
          revertReason: null
        };
      } else {
        // Attempt on-chain revert replay & error decoding
        let decodedDetails = 'Transaction reverted on-chain';
        let customError = null;
        try {
          if (rawTxObj) {
            const revertInfo = await simulator.decodeOnChainRevert({
              from: wallet.address,
              to: rawTxObj.to,
              data: rawTxObj.data,
              value: rawTxObj.value,
              gasLimit: rawTxObj.gasLimit
            }, receipt?.blockNumber);
            decodedDetails = revertInfo.reason || revertInfo.simple || 'Transaction reverted on-chain';
            customError = revertInfo.customError;
          }
        } catch (e) {}

        completedCount++;
        failCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        logger.walletLine(wallet.address, 'FAILED', decodedDetails);

        Notifier.sendMintAlert({
          address: wallet.address,
          status: 'FAILED',
          txHash: broadcastResult.txHash,
          explorerUrl,
          contractAddress: nftContractAddress,
          error: decodedDetails
        });

        return {
          timestamp: new Date().toISOString(),
          formattedTime: new Date().toLocaleString(),
          network: chainConfig?.name || network.name,
          contractAddress: nftContractAddress,
          walletAddress: wallet.address,
          maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
          mode: 'ALLOWLIST',
          quantity,
          status: 'FAILED',
          txHash: broadcastResult.txHash,
          blockNumber: receipt?.blockNumber ? Number(receipt.blockNumber) : null,
          gasUsed: receipt?.gasUsed ? receipt.gasUsed.toString() : null,
          gasPriceGwei: receipt?.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') : null,
          mintDurationMs,
          details: decodedDetails,
          revertReason: customError
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
        timestamp: new Date().toISOString(),
        formattedTime: new Date().toLocaleString(),
        network: chainConfig?.name || network.name,
        contractAddress: nftContractAddress,
        walletAddress: wallet.address,
        maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
        mode: 'ALLOWLIST',
        quantity,
        status: 'FAILED',
        txHash: null,
        blockNumber: null,
        gasUsed: null,
        gasPriceGwei: null,
        mintDurationMs: null,
        details: friendlyMsg,
        revertReason: null
      };
    }
  });

  const rawResults = await Promise.allSettled(txPromises);
  const results = rawResults.map(r => r.value || {
    timestamp: new Date().toISOString(),
    formattedTime: new Date().toLocaleString(),
    address: 'Unknown',
    status: 'FAILED',
    details: r.reason?.message
  });
  const totalSessionMs = Date.now() - startTimeMs;

  // Print Mint Complete Status and Summary Table
  logger.mintComplete(successCount, failCount, totalWallets);
  logger.summaryTable(results.map(r => ({
    address: r.walletAddress || r.address,
    status: r.status,
    txHash: r.txHash,
    mintDurationMs: r.mintDurationMs,
    details: r.details
  })));

  // Print Speed Performance Report
  logger.speedReport(results, totalSessionMs);

  // 6. Auto-forward NFTs if recipient configured
  const successfulResults = results.filter(r => r.status === 'SUCCESS' && r.txHash);
  if (recipientAddress && successfulResults.length > 0) {
    await forwardNFTs(successfulResults, wallets, provider, recipientAddress, explorerUrl);
  }

  // Non-blocking async history recording with timestamps & session duration
  const historyResults = results.map(r => ({
    ...r,
    totalSessionDurationMs: totalSessionMs
  }));
  try {
    mintHistoryWriter.write(historyResults);
    await mintHistoryWriter.flush();
  } catch (e) {}

  return results;
}

module.exports = { runAllowlistMint, fetchSingleCalldata, normalizeOpenSeaMintTransaction };
