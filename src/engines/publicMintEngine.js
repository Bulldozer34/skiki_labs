const { getPublicDropParams, encodeMintPublicCalldata, SEADROP_ADDRESSES } = require('../contracts/seadrop');
const { getChainKey } = require('../utils/chains');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const WalletService = require('../services/walletService');
const { ethers } = require('ethers');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const { resolveGasFees, formatGasSelection } = require('../utils/gasEstimator');

/**
 * Execute public mint purely from on-chain SeaDrop parameters (No OpenSea API required)
 * @param {object} config 
 */
async function runPublicMint(config) {
  const { wallets, provider, rpcUrls, nftContractAddress, chain, quantity, gasSettings, recipientAddress } = config;
  let { startTime } = config;
  
  const chainKey = getChainKey(chain);
  const explorerUrl = chain?.explorerUrl || 'https://etherscan.io';
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

  // Pre-warm sockets immediately across all RPCs (non-blocking)
  connectionManager.preWarmSockets(broadcaster.rpcUrls).catch(() => {});

  logger.info('Reading public drop parameters from SeaDrop contract...');
  const dropParams = await getPublicDropParams(provider, seadropAddress, nftContractAddress);
  
  const mintPriceEth = ethers.formatEther(dropParams.mintPrice);
  const totalCostPerWalletWei = dropParams.mintPrice * BigInt(quantity);
  const totalCostPerWalletEth = ethers.formatEther(totalCostPerWalletWei);

  logger.info(`Public Mint Price: ${mintPriceEth} ETH (Total: ${totalCostPerWalletEth} ETH for ${quantity} NFTs)`);
  logger.info(`Fee Recipient: ${dropParams.feeRecipient} (${dropParams.feeRecipientSource})`);
  logger.info(`Restricted Fee Recipients: ${dropParams.restrictFeeRecipients ? 'Yes' : 'No'}`);
  logger.info(`Max Total Per Wallet: ${dropParams.maxMintable.toString()}`);

  const onChainStartTime = Number(dropParams.startTime);
  const onChainEndTime = Number(dropParams.endTime);
  const nowSec = Math.floor(Date.now() / 1000);

  if (onChainEndTime > 0 && onChainEndTime <= nowSec) {
    logger.error(`This public drop ended on-chain at ${new Date(onChainEndTime * 1000).toLocaleString()}!`);
    throw new Error('Public drop has already ended on-chain.');
  }

  if (onChainStartTime > 0) {
    if (onChainStartTime > nowSec) {
      // Future drop on-chain: automatically synchronize if within 15 minutes or if scheduled earlier
      if (!startTime || Math.abs(onChainStartTime - startTime) <= 900 || onChainStartTime > startTime) {
        if (startTime && startTime !== onChainStartTime) {
          logger.timer(`🎯 Auto-synchronized start time to exact on-chain drop time: ${new Date(onChainStartTime * 1000).toLocaleTimeString()} (in ${logger.formatDuration(onChainStartTime - nowSec)})`);
        } else if (!startTime) {
          logger.timer(`🎯 Detected on-chain drop start time: ${new Date(onChainStartTime * 1000).toLocaleTimeString()} (in ${logger.formatDuration(onChainStartTime - nowSec)})`);
        }
        startTime = onChainStartTime;
      }
    } else {
      // On-chain drop is already live
      if (startTime && startTime > nowSec) {
        logger.warn(`On-chain drop is ALREADY live since ${new Date(onChainStartTime * 1000).toLocaleTimeString()}! Overriding delay to mint immediately.`);
        startTime = 0;
      }
    }
  }

  const gasFees = await resolveGasFees(provider, gasSettings, 'turbo');
  const maxFeePerGasWei = gasFees.maxFeePerGas;
  const maxPriorityFeePerGasWei = gasFees.maxPriorityFeePerGas;
  logger.gasEstimate(formatGasSelection(gasFees));

  // Pre-check balances
  const requiredBalanceWei = totalCostPerWalletWei + (maxFeePerGasWei * BigInt(gasSettings.gasLimit || 300000));
  for (const wallet of wallets) {
    const bal = await provider.getBalance(wallet.address);
    if (bal < requiredBalanceWei) {
      logger.warn(`Wallet ${wallet.address.slice(0, 6)}... may have insufficient funds (Balance: ${ethers.formatEther(bal)} ETH, Est. Needed: ${ethers.formatEther(requiredBalanceWei)} ETH)`);
    }
  }

  // Pre-encode calldata and pre-fetch nonces
  logger.info('Pre-fetching nonces and pre-signing transactions for all wallets...');
  await WalletService.prefetchNonces(wallets, provider);

  const preparedTxs = await Promise.all(wallets.map(async (wallet) => {
    try {
      const nonce = WalletService.consumeNonce(wallet.address) ?? await provider.getTransactionCount(wallet.address, 'pending');
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

  // --- UNIFIED CONTINUOUS WARMUP PIPELINE ---
  const deadlineMs = startTime ? startTime * 1000 : 0;

  if (deadlineMs > Date.now()) {
    const totalRemaining = Math.ceil((deadlineMs - Date.now()) / 1000);
    logger.timer(`Drop starts at ${new Date(deadlineMs).toLocaleTimeString()} (in ${logger.formatDuration(totalRemaining)})`);

    let didT15 = false;
    let didT5 = false;
    let didT2 = false;

    // Run unified continuous countdown until drop start
    await new Promise(resolve => {
      let isBusy = false;

      const tick = async () => {
        if (isBusy) return;
        const remainingMs = deadlineMs - Date.now();

        // 1. T-15s Milestone: Nonce refresh & re-sign
        if (remainingMs <= 15000 && !didT15) {
          didT15 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-15s: Refreshing nonces...]    \n`);
          try {
            logger.info('T-15s: Refreshing nonces across all wallets...');
            await WalletService.prefetchNonces(validPrepared.map(p => p.wallet), provider);
            for (const p of validPrepared) {
              try {
                const freshNonce = WalletService.consumeNonce(p.wallet.address) ?? await provider.getTransactionCount(p.wallet.address, 'pending');
                if (freshNonce !== p.nonce) {
                  p.nonce = freshNonce;
                  p.rawTxObj.nonce = freshNonce;
                  p.signedTx = await p.wallet.signTransaction(p.rawTxObj);
                }
              } catch (e) {}
            }
          } catch (e) {}
          isBusy = false;
        }

        // 2. T-5s Milestone: Socket pool pre-warm
        if (remainingMs <= 5000 && !didT5) {
          didT5 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-5s: Pre-warming sockets...]    \n`);
          try {
            logger.info('T-5s: Pre-warming socket pool across all RPC endpoints...');
            await connectionManager.preWarmSockets(broadcaster.rpcUrls);
          } catch (e) {}
          isBusy = false;
        }

        // 3. T-2s Milestone: Pre-flight simulation
        if (remainingMs <= 2000 && !didT2) {
          didT2 = true;
          isBusy = true;
          process.stdout.write(`\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))} [T-2s: Pre-flight simulation...]    \n`);
          try {
            if (validPrepared[0] && validPrepared[0].rawTxObj) {
              const sim = await simulator.simulate({
                from: validPrepared[0].wallet.address,
                to: seadropAddress,
                data: validPrepared[0].rawTxObj.data,
                value: totalCostPerWalletWei
              }, true);
              if (!sim.success) {
                logger.warn(`Pre-flight simulation notice: ${sim.revertReason}`);
              } else {
                logger.success('Pre-flight simulation passed.');
              }
            }
          } catch (e) {}
          isBusy = false;
        }

        // Final hold check
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

  // Re-warm sockets right before firing
  await connectionManager.preWarmSockets(broadcaster.rpcUrls);

  // Multi-RPC Simultaneous Broadcast Racing
  logger.speed(`>>> FIRE! Multi-RPC Broadcasting ${validPrepared.length} transactions across ${broadcaster.rpcUrls.length} node(s) <<<`);
  const startTimeMs = Date.now();
  const totalWallets = validPrepared.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const broadcastPromises = validPrepared.map(async ({ wallet, signedTx, rawTxObj }) => {
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

        return {
          timestamp: new Date().toISOString(),
          formattedTime: new Date().toLocaleString(),
          network: chainConfig?.name || network.name,
          contractAddress: nftContractAddress,
          walletAddress: wallet.address,
          maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
          mode: 'PUBLIC',
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
          const revertInfo = await simulator.decodeOnChainRevert({
            from: wallet.address,
            to: seadropAddress,
            data: rawTxObj?.data,
            value: totalCostPerWalletWei,
            gasLimit: parseInt(gasSettings.gasLimit) || 300000
          }, receipt?.blockNumber);
          decodedDetails = revertInfo.reason || revertInfo.simple || 'Transaction reverted on-chain';
          customError = revertInfo.customError;
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
          mode: 'PUBLIC',
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
        mode: 'PUBLIC',
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

  const rawResults = await Promise.allSettled(broadcastPromises);
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

  // Auto-forward NFTs if recipient configured
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

module.exports = { runPublicMint };
