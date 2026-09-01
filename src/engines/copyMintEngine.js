/**
 * Copy Mint Engine — Master Coordinator for Whale Copy-Minting.
 *
 * Coordinates:
 * 1. Transaction candidate validation & deduplication.
 * 2. Per-wallet calldata rewriting & recipient hijacking.
 * 3. Payment detection & simulation safety gates.
 * 4. Parallel multi-wallet preflight & transaction signing.
 * 5. High-speed broadcast via MultiRpcBroadcaster / RPC pool.
 * 6. Post-mint auto-forwarding & multi-channel alert notifications.
 */

const { ethers } = require('ethers');
const logger = require('../utils/logger');
const dedupeStore = require('./dedupeStore');
const { classifyMintTransaction } = require('./mintClassifier');
const { rewriteMintCalldataForWallet, rewriteMintCalldataQuantity } = require('./calldataRewriter');
const PaymentDetector = require('./paymentDetector');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const { buildEndpoints } = require('../utils/rpcPool');
const { estimateGasWithPreset } = require('../utils/gasEstimator');
const { forwardNftsFromReceipt } = require('./nftForwarder');
const notifier = require('../utils/notifier');

class CopyMintEngine {
  /**
   * Execute copy-mint across multiple burner wallets.
   *
   * @param {object} params
   * @param {object} params.candidate - Detected mint candidate
   * @param {Array<ethers.Wallet>} params.wallets - Executing signer wallets
   * @param {ethers.Provider} params.provider - RPC Provider
   * @param {object} [params.chainConfig] - Chain configuration
   * @param {object} [params.options] - Execution options
   * @param {number} [params.options.quantity=1] - Quantity to mint per wallet
   * @param {number} [params.options.maxMintEth=0.05] - Maximum ETH cost ceiling
   * @param {string} [params.options.gasMode='RAPID'] - Gas preset
   * @param {string} [params.options.recipientAddress] - NFT forwarding target
   * @param {boolean} [params.options.autoForward=true] - Forward minted NFTs
   * @param {boolean} [params.options.skipSimulation=false] - Blind broadcast
   * @returns {Promise<object>} Execution report
   */
  static async execute(params) {
    const t0 = Date.now();
    const {
      candidate,
      wallets = [],
      provider,
      chainConfig = {},
      options = {}
    } = params;

    const executionId = `exec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const quantity = options.quantity || 1;
    const maxMintEth = options.maxMintEth !== undefined ? options.maxMintEth : parseFloat(process.env.MAX_MINT_ETH || '0.05');
    const recipientAddress = options.recipientAddress || process.env.RECIPIENT_ADDRESS || null;
    const autoForward = options.autoForward !== false && Boolean(recipientAddress);

    logger.separator();
    logger.info(`[CopyMint] 🎯 Initiating copy-mint execution (${executionId})`);
    logger.info(`[CopyMint] Target Contract: ${candidate.targetContract} | Whale: ${candidate.sourceWallet || 'Manual'}`);

    // 1. Wallets Check
    if (!wallets || wallets.length === 0) {
      logger.error('[CopyMint] No execution wallets provided. Aborting.');
      return { success: false, executionId, reason: 'no_wallets' };
    }

    // 2. Dedupe Check on Contract Execution
    if (dedupeStore.checkContractExecution(candidate.targetContract, candidate.calldata, candidate.value)) {
      logger.warn('[CopyMint] Duplicate contract call already executed recently. Skipping.');
      return { success: false, executionId, reason: 'duplicate_contract_execution' };
    }

    // 3. Classify if not already classified
    const classification = candidate.classification || classifyMintTransaction(
      candidate.calldata,
      candidate.value,
      candidate.targetContract,
      options.copyUnknownCalls
    );

    if (!classification.isMint) {
      logger.warn(`[CopyMint] Rejected non-mint transaction: ${classification.reason}`);
      return { success: false, executionId, reason: classification.reason };
    }

    // 4. Calldata Rewriting & Payment Detection for Lead Wallet
    const leadWallet = wallets[0];
    let leadCalldata = rewriteMintCalldataForWallet(
      candidate.calldata,
      leadWallet.address,
      candidate.sourceWallet
    );

    if (quantity > 1) {
      leadCalldata = rewriteMintCalldataQuantity(leadCalldata, quantity) || leadCalldata;
    }

    logger.info('[CopyMint] Simulating & detecting payment requirements...');
    const paymentPlan = await PaymentDetector.detect({
      provider,
      contractAddress: candidate.targetContract,
      calldata: leadCalldata,
      sourceTxValue: candidate.value,
      executingWallet: leadWallet.address,
      quantity,
      maxMintEth,
      skipSimulation: options.skipSimulation || false
    });

    if (!paymentPlan.shouldExecute) {
      logger.error(`[CopyMint] Payment gate rejected execution: ${paymentPlan.reason}`);
      return { success: false, executionId, reason: paymentPlan.reason };
    }

    logger.success(`[CopyMint] Payment Plan Approved: Mode=${paymentPlan.paymentMode} | Cost=${paymentPlan.selectedValueEth} ETH`);

    // 5. Gas Estimation
    const gasParams = await estimateGasWithPreset(
      provider,
      options.gasMode || 'RAPID',
      chainConfig
    ).catch(() => ({
      maxFeePerGas: candidate.maxFeePerGas ? BigInt(candidate.maxFeePerGas) : ethers.parseUnits('1.5', 'gwei'),
      maxPriorityFeePerGas: candidate.maxPriorityFeePerGas ? BigInt(candidate.maxPriorityFeePerGas) : ethers.parseUnits('0.1', 'gwei'),
      gasPrice: candidate.gasPrice ? BigInt(candidate.gasPrice) : null
    }));

    const gasLimit = BigInt(options.gasLimit || candidate.gasLimit || 250000);

    // 6. Setup Broadcaster
    let broadcaster = null;
    try {
      const endpoints = buildEndpoints(chainConfig, provider._getConnection ? provider._getConnection().url : null);
      if (endpoints && endpoints.length > 0) {
        broadcaster = new MultiRpcBroadcaster(endpoints, chainConfig.chainId || 1);
      }
    } catch {}

    // 7. Prepare and Pre-sign Transactions across All Wallets
    const signedPlans = [];
    const tPreflight = Date.now();

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      const connectedWallet = wallet.connect(provider);

      // Calldata rewritten for this specific wallet
      let walletCalldata = rewriteMintCalldataForWallet(
        candidate.calldata,
        wallet.address,
        candidate.sourceWallet
      );
      if (quantity > 1) {
        walletCalldata = rewriteMintCalldataQuantity(walletCalldata, quantity) || walletCalldata;
      }

      try {
        const nonce = await provider.getTransactionCount(wallet.address, 'pending');
        const txReq = {
          to: candidate.targetContract,
          data: walletCalldata,
          value: paymentPlan.selectedValue,
          nonce,
          gasLimit,
          chainId: chainConfig.chainId || (await provider.getNetwork()).chainId
        };

        if (gasParams.maxFeePerGas) {
          txReq.type = 2;
          txReq.maxFeePerGas = gasParams.maxFeePerGas;
          txReq.maxPriorityFeePerGas = gasParams.maxPriorityFeePerGas;
        } else if (gasParams.gasPrice) {
          txReq.type = 0;
          txReq.gasPrice = gasParams.gasPrice;
        }

        const signedTx = await connectedWallet.signTransaction(txReq);
        signedPlans.push({
          index: i,
          walletAddress: wallet.address,
          signedTx,
          txReq
        });
      } catch (err) {
        logger.warn(`[CopyMint] Failed to pre-sign for wallet #${i + 1} (${wallet.address.slice(0, 8)}...): ${err.message}`);
      }
    }

    if (signedPlans.length === 0) {
      logger.error('[CopyMint] No transactions could be signed. Aborting.');
      return { success: false, executionId, reason: 'signing_failed' };
    }

    // 8. Broadcast in Parallel
    const tBroadcast = Date.now();
    logger.info(`[CopyMint] ⚡ Broadcasting ${signedPlans.length} transactions in parallel...`);

    const broadcastResults = await Promise.allSettled(
      signedPlans.map(async (plan) => {
        if (broadcaster) {
          return await broadcaster.broadcastFlood(plan.signedTx);
        } else {
          const res = await provider.broadcastTransaction(plan.signedTx);
          return { txHash: res.hash, fastestRpc: 'default' };
        }
      })
    );

    // 9. Mark Executed in Dedupe Cache
    dedupeStore.markExecuted(executionId, candidate.targetContract, candidate.calldata, paymentPlan.selectedValue);
    if (candidate.sourceTxHash) {
      dedupeStore.markSourceTx(candidate.sourceTxHash, executionId);
    }

    const receipts = [];
    let submittedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < broadcastResults.length; i++) {
      const plan = signedPlans[i];
      const result = broadcastResults[i];

      if (result.status === 'fulfilled') {
        submittedCount++;
        const txHash = result.value.txHash;
        logger.success(`[CopyMint] Wallet #${plan.index + 1} (${plan.walletAddress.slice(0, 8)}...) Submitted! Tx: ${txHash}`);
        receipts.push({
          walletIndex: plan.index,
          walletAddress: plan.walletAddress,
          status: 'submitted',
          txHash,
          rpc: result.value.fastestRpc
        });
      } else {
        failedCount++;
        logger.error(`[CopyMint] Wallet #${plan.index + 1} (${plan.walletAddress.slice(0, 8)}...) Broadcast Failed: ${result.reason?.message || result.reason}`);
        receipts.push({
          walletIndex: plan.index,
          walletAddress: plan.walletAddress,
          status: 'failed',
          error: result.reason?.message || String(result.reason)
        });
      }
    }

    const totalDurationMs = Date.now() - t0;
    logger.success(`[CopyMint] Execution finished in ${totalDurationMs}ms | Submitted: ${submittedCount}/${signedPlans.length}`);

    // 10. Post-Mint Auto-Forwarding in Background
    if (autoForward && recipientAddress && submittedCount > 0) {
      setTimeout(async () => {
        logger.info(`[CopyMint/Forwarder] Polling receipts to forward minted tokens to ${recipientAddress}...`);
        for (const receipt of receipts.filter(r => r.status === 'submitted')) {
          try {
            const txReceipt = await provider.waitForTransaction(receipt.txHash, 1, 30000);
            if (txReceipt && txReceipt.status === 1) {
              const forwarderWallet = wallets[receipt.walletIndex].connect(provider);
              await forwardNftsFromReceipt({
                receipt: txReceipt,
                signer: forwarderWallet,
                recipientAddress,
                provider
              });
            }
          } catch (fwdErr) {
            logger.warn(`[CopyMint/Forwarder] Forwarding warning for ${receipt.txHash}: ${fwdErr.message}`);
          }
        }
      }, 1000);
    }

    // 11. Send Multi-Channel Notifications (Discord & Telegram)
    const report = {
      executionId,
      targetContract: candidate.targetContract,
      whaleWallet: candidate.sourceWallet,
      whaleLabel: candidate.label || 'Whale',
      sourceTxHash: candidate.sourceTxHash,
      paymentMode: paymentPlan.paymentMode,
      costEth: paymentPlan.selectedValueEth,
      quantity,
      submittedCount,
      failedCount,
      totalWallets: wallets.length,
      receipts,
      durationMs: totalDurationMs
    };

    notifier.sendCopyMintAlert(report).catch(() => {});

    return {
      success: submittedCount > 0,
      executionId,
      submittedCount,
      failedCount,
      receipts,
      durationMs: totalDurationMs,
      paymentPlan
    };
  }

  /**
   * Simulate a copy-mint on a past transaction hash without broadcasting.
   *
   * @param {object} params
   * @param {string} params.txHash - Transaction hash to simulate
   * @param {ethers.Provider} params.provider - RPC Provider
   * @param {ethers.Wallet} params.sampleWallet - Wallet used for address substitution
   * @param {number} [params.quantity=1] - Quantity
   * @returns {Promise<object>} Simulation report
   */
  static async simulate(params) {
    const { txHash, provider, sampleWallet, quantity = 1 } = params;

    logger.info(`[CopyMint/Simulate] Inspecting transaction: ${txHash}`);
    const tx = await provider.getTransaction(txHash);

    if (!tx) {
      throw new Error(`Transaction not found on-chain for hash: ${txHash}`);
    }

    const classification = classifyMintTransaction(tx.data, tx.value ? tx.value.toString() : '0', tx.to, true);
    const rewrittenCalldata = rewriteMintCalldataForWallet(
      tx.data,
      sampleWallet.address,
      tx.from
    );

    const paymentPlan = await PaymentDetector.detect({
      provider,
      contractAddress: tx.to,
      calldata: rewrittenCalldata,
      sourceTxValue: tx.value ? tx.value.toString() : '0',
      executingWallet: sampleWallet.address,
      quantity,
      skipSimulation: false
    });

    return {
      txHash: tx.hash,
      from: tx.from,
      to: tx.to,
      classification,
      paymentPlan,
      originalCalldata: tx.data,
      rewrittenCalldata,
      simulatedWallet: sampleWallet.address
    };
  }
}

module.exports = CopyMintEngine;
