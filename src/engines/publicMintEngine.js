const { getPublicDropParams, encodeMintPublicCalldata, SEADROP_ADDRESSES } = require('../contracts/seadrop');
const { getChainKey } = require('../utils/chains');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const { ethers } = require('ethers');
const fs = require('fs');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const { estimateGas, formatGasEstimate } = require('../utils/gasEstimator');

/**
 * Execute public mint purely from on-chain SeaDrop parameters (No OpenSea API required)
 * @param {object} config 
 */
async function runPublicMint(config) {
  const { wallets, provider, rpcUrls, nftContractAddress, chain, quantity, gasSettings, recipientAddress } = config;
  let { startTime } = config;
  
  const chainKey = getChainKey(chain);
  const explorerUrl = chain.explorerUrl || 'https://etherscan.io';
  const seadropAddress = SEADROP_ADDRESSES[chainKey] || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';

  logger.separator();
  logger.info(`Mode: Direct On-Chain SeaDrop Public Mint`);
  logger.info(`Target Contract: ${nftContractAddress}`);
  logger.info(`SeaDrop Contract: ${seadropAddress}`);
  logger.info(`Chain: ${chainKey}`);
  logger.info(`Quantity per Wallet: ${quantity}`);
  logger.separator();

  // Initialize Multi-RPC Broadcaster & Simulator
  const network = await provider.getNetwork();
  const broadcaster = new MultiRpcBroadcaster(rpcUrls || [provider._getConnection ? provider._getConnection().url : config.rpcUrl], Number(network.chainId));
  const simulator = new PreflightSimulator(provider);

  logger.info('Reading public drop parameters from SeaDrop contract...');
  const dropParams = await getPublicDropParams(provider, seadropAddress, nftContractAddress);
  
  const mintPriceEth = ethers.formatEther(dropParams.mintPrice);
  const totalCostPerWalletWei = dropParams.mintPrice * BigInt(quantity);
  const totalCostPerWalletEth = ethers.formatEther(totalCostPerWalletWei);

  logger.info(`Public Mint Price: ${mintPriceEth} ETH (Total: ${totalCostPerWalletEth} ETH for ${quantity} NFTs)`);
  logger.info(`Fee Recipient: ${dropParams.feeRecipient}`);
  logger.info(`Max Total Per Wallet: ${dropParams.maxMintable.toString()}`);

  const onChainStartTime = Number(dropParams.startTime);
  if (!startTime && onChainStartTime > 0) {
    startTime = onChainStartTime;
  }

  // Pre-check balances
  const requiredBalanceWei = totalCostPerWalletWei + (ethers.parseUnits((gasSettings.maxFeePerGas || '0.1').toString(), 'gwei') * BigInt(gasSettings.gasLimit || 300000));
  for (const wallet of wallets) {
    const bal = await provider.getBalance(wallet.address);
    if (bal < requiredBalanceWei) {
      logger.warn(`Wallet ${wallet.address.slice(0, 6)}... may have insufficient funds (Balance: ${ethers.formatEther(bal)} ETH, Est. Needed: ${ethers.formatEther(requiredBalanceWei)} ETH)`);
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

  // Pre-encode calldata and pre-fetch nonces
  logger.info('Pre-building and pre-signing transactions for all wallets...');

  const preparedTxs = await Promise.all(wallets.map(async (wallet) => {
    try {
      const nonce = await provider.getTransactionCount(wallet.address, 'pending');
      const calldata = encodeMintPublicCalldata(nftContractAddress, dropParams.feeRecipient, wallet.address, quantity);
      
      const tx = {
        to: seadropAddress,
        data: calldata,
        value: totalCostPerWalletWei,
        gasLimit: parseInt(gasSettings.gasLimit) || 300000,
        maxFeePerGas: maxFeePerGasWei,
        maxPriorityFeePerGas: maxPriorityFeePerGasWei,
        nonce: nonce,
        chainId: network.chainId,
        type: 2
      };

      logger.speed(`Pre-signing offline tx for ${wallet.address.slice(0, 6)}... (Nonce: ${nonce})`);
      const signedTx = await wallet.signTransaction(tx);
      return { wallet, signedTx, rawTxObj: tx, nonce, error: null };
    } catch (err) {
      logger.error(`Error preparing tx for ${wallet.address.slice(0, 6)}...: ${err.message}`);
      return { wallet, signedTx: null, rawTxObj: null, nonce: 0, error: err.message };
    }
  }));

  const validPrepared = preparedTxs.filter(p => p.signedTx);

  if (validPrepared.length === 0) {
    throw new Error('No transactions could be prepared.');
  }

  // Handle countdown if start time is in the future
  const now = Math.floor(Date.now() / 1000);
  if (startTime && startTime > now) {
    const secondsRemaining = startTime - now;
    logger.timer(`Drop starts at ${new Date(startTime * 1000).toLocaleTimeString()} (in ${secondsRemaining}s)`);

    if (secondsRemaining > 10) {
      await logger.countdown(secondsRemaining - 10);
      
      // T-10s: Refresh nonces
      logger.info('T-10s: Refreshing nonces across all wallets...');
      for (const p of validPrepared) {
        try {
          const freshNonce = await provider.getTransactionCount(p.wallet.address, 'pending');
          if (freshNonce !== p.nonce) {
            p.nonce = freshNonce;
            p.rawTxObj.nonce = freshNonce;
            p.signedTx = await p.wallet.signTransaction(p.rawTxObj);
          }
        } catch (e) {}
      }

      // T-5s: Warm socket connections
      logger.info('T-5s: Pre-warming socket pool across all RPC endpoints...');
      await connectionManager.preWarmSockets(broadcaster.rpcUrls);
      await logger.countdown(4.5);

      // T-0.5s: Pre-flight simulation check
      if (validPrepared[0] && validPrepared[0].rawTxObj) {
        const sim = await simulator.simulate({
          from: validPrepared[0].wallet.address,
          to: seadropAddress,
          data: validPrepared[0].rawTxObj.data,
          value: totalCostPerWalletWei
        });
        if (!sim.success) {
          logger.warn(`Pre-flight simulation notice: ${sim.revertReason}`);
        } else {
          logger.success('Pre-flight simulation passed (0 gas cost).');
        }
      }
      await logger.countdown(0.5);
    } else {
      await logger.countdown(secondsRemaining);
    }
  }

  // Multi-RPC Simultaneous Broadcast Racing
  logger.speed(`>>> FIRE! Multi-RPC Broadcasting ${validPrepared.length} transactions across ${broadcaster.rpcUrls.length} node(s) <<<`);
  const startTimeMs = Date.now();
  const totalWallets = validPrepared.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const broadcastPromises = validPrepared.map(async ({ wallet, signedTx }) => {
    const walletStartMs = Date.now();
    try {
      const broadcastResult = await broadcaster.broadcastFastest(signedTx);
      logger.walletLine(wallet.address, 'Sent', `Fastest RPC: ${broadcastResult.fastestRpc} (${broadcastResult.durationMs}ms)`);

      const { receipt } = await broadcaster.waitForReceiptFastest(broadcastResult.txHash, 1, 60000);
      const mintDurationMs = Date.now() - walletStartMs;
      const latencyMs = Date.now() - startTimeMs;

      if (receipt && receipt.status === 1) {
        completedCount++;
        successCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        logger.walletLine(wallet.address, 'SUCCESS', `Block #${receipt.blockNumber} (${mintDurationMs}ms)`);

        // Trigger Webhook Notification
        Notifier.sendMintAlert({
          address: wallet.address,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          explorerUrl,
          contractAddress: nftContractAddress,
          latencyMs,
          blockNumber: receipt.blockNumber
        });

        // DO NOT attach wallet object to return dict (SEC-01 fix)
        return {
          address: wallet.address,
          status: 'SUCCESS',
          txHash: broadcastResult.txHash,
          receipt,
          mintDurationMs,
          details: `Block ${receipt.blockNumber} (${mintDurationMs}ms)`
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

  const rawResults = await Promise.allSettled(broadcastPromises);
  const results = rawResults.map(r => r.value || { address: 'Unknown', status: 'FAILED', details: r.reason?.message });
  const totalSessionMs = Date.now() - startTimeMs;

  // Print Mint Complete Status (e.g. 10/10 minted) and Summary Table
  logger.mintComplete(successCount, failCount, totalWallets);
  logger.summaryTable(results);

  // Print Speed Performance Report
  logger.speedReport(results, totalSessionMs);

  // Auto-forward NFTs if recipient configured
  const successfulResults = results.filter(r => r.status === 'SUCCESS' && r.receipt);
  if (recipientAddress && successfulResults.length > 0) {
    await forwardNFTs(successfulResults, wallets, provider, recipientAddress, explorerUrl);
  }

  // Non-blocking async history recording (SEC-01)
  // Enrich results with session timing data
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

module.exports = { runPublicMint };
