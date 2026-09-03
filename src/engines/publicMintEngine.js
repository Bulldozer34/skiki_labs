const { getPublicDropParams, encodeMintPublicCalldata, SEADROP_ADDRESSES } = require('../contracts/seadrop');
const { getChainKey } = require('../utils/chains');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const SeaportOfferEngine = require('../services/seaportOfferEngine');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const WalletService = require('../services/walletService');
const { ethers } = require('ethers');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const MintTracker = require('../core/mintTracker');
const { resolveGasFees, formatGasSelection } = require('../utils/gasEstimator');
const { waitForDropWindow, resolveLeadTimeMs, calibrateLeadTimeMs } = require('../core/dropClock');
const gcGuard = require('../core/gcGuard');
const { SequencerFeed } = require('../services/sequencerFeed');

/**
 * Execute public mint purely from on-chain SeaDrop parameters (No OpenSea API required)
 * @param {object} config
 * @param {{feed?: import('../services/sequencerFeed').SequencerFeed}} state
 *   Resources the caller must tear down regardless of how this returns.
 */
async function executePublicMint(config, state) {
  const { wallets, provider, rpcUrls, endpoints, feedUrl, nftContractAddress, chain: chainConfig, quantity, gasSettings, recipientAddress } = config;
  const chain = chainConfig;
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

  // Sequencer feed first, so the broadcaster can use it for inclusion instead of
  // polling. On a FIFO chain this is also the only way to read the sequencer's
  // clock without spending a round-trip, which is what the early trigger needs.
  const feed = feedUrl ? new SequencerFeed(feedUrl) : null;
  state.feed = feed;
  if (feed) {
    const live = await feed.start().catch(() => false);
    if (!live) {
      logger.warn('Sequencer feed unavailable — falling back to block polling for drop detection.');
    }
  }

  const broadcastTargets = endpoints
    || rpcUrls
    || [provider._getConnection ? provider._getConnection().url : config.rpcUrl];
  const broadcaster = new MultiRpcBroadcaster(broadcastTargets, Number(network.chainId), { feed });
  const simulator = new PreflightSimulator(provider);

  const sequencerTarget = broadcaster.endpoints.find(e => e.broadcastOnly);
  if (sequencerTarget) {
    logger.speed(`Write path: ${sequencerTarget.label} (direct sequencer ingress, no forwarding hop)`);
  }

  // Pre-warm sockets immediately across all RPCs (non-blocking)
  connectionManager.preWarmSockets(broadcaster.rpcUrls).catch(() => {});

  logger.info('Reading public drop parameters from SeaDrop contract...');
  const dropParams = await getPublicDropParams(provider, seadropAddress, nftContractAddress);
  
  const armedPriceWei = dropParams.mintPrice;
  let currentMintPriceWei = dropParams.mintPrice;
  const isFreeMint = (armedPriceWei === 0n);
  const mintPriceEth = ethers.formatEther(dropParams.mintPrice);
  let totalCostPerWalletWei = dropParams.mintPrice * BigInt(quantity);
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

  // Honours the preset chosen in the CLI — 'ultra' engages the 75th-percentile,
  // +60% tip boost and 3x base multiplier path inside gasEstimator.
  const gasFees = await resolveGasFees(provider, gasSettings);
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
        gasLimit: Math.max(parseInt(gasSettings.gasLimit) || 350000, 160000 + (quantity * 25000)),
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

  // --- UNIFIED CONTINUOUS WARMUP & HIGH-PRECISION SPIN-LOOP PIPELINE ---
  // The lead time starts at the configured/default value and is replaced at T-5s
  // by one measured from the live path, unless the operator pinned it.
  let leadTimeMs = resolveLeadTimeMs();
  const deadlineMs = startTime ? startTime * 1000 : 0;

  // Pre-generate binary JSON-RPC buffers for zero runtime serialization
  for (const p of validPrepared) {
    if (p.signedTx) {
      p.rawBuffer = connectionManager.createRawBufferPayload(p.signedTx);
    }
  }

  /**
   * Pre-sign the `NotActive()` recovery ladder.
   *
   * A revert still consumes the nonce, so a retry needs nonce+1, nonce+2 — and
   * the old code discovered that at revert time by calling
   * `getTransactionCount` and signing on the spot. That is the worst possible
   * moment: learning the revert already cost one round-trip (~240ms), the nonce
   * fetch costs another, and signing costs a few ms more, by which point the
   * chain has produced roughly five blocks. Signing them during warmup makes
   * the retry a pure send.
   *
   * @param {object} prepared
   * @param {number} depth How many spare transactions to sign
   */
  const presignBackups = async (prepared, depth = 3) => {
    prepared.backups = [];
    for (let i = 1; i <= depth; i++) {
      try {
        const txObj = { ...prepared.rawTxObj, nonce: prepared.nonce + i };
        const signed = await prepared.wallet.signTransaction(txObj);
        prepared.backups.push({
          nonce: txObj.nonce,
          signedTx: signed,
          rawBuffer: connectionManager.createRawBufferPayload(signed)
        });
      } catch (err) {
        break;
      }
    }
  };

  await Promise.all(validPrepared.map(p => presignBackups(p)));

  const dropTrigger = await waitForDropWindow({
    deadlineMs,
    leadTimeMs: () => leadTimeMs,
    label: 'Drop',
    milestones: [
      {
        atMs: 15000,
        label: 'T-15s: Price watchdog & nonces refresh',
        run: async () => {
          logger.info('T-15s: Refreshing nonces and verifying on-chain price integrity...');

          // 1. Live On-Chain Price & Bait-and-Switch Watchdog
          try {
            const freshDrop = await getPublicDropParams(provider, seadropAddress, nftContractAddress);
            if (freshDrop && freshDrop.mintPrice !== currentMintPriceWei) {
              const oldPriceEth = ethers.formatEther(currentMintPriceWei);
              const newPriceEth = ethers.formatEther(freshDrop.mintPrice);

              // Strict Bait & Switch Guard: Free mint stealth-changed to paid
              if (isFreeMint && freshDrop.mintPrice > 0n) {
                logger.error(`🚨 BAIT & SWITCH DETECTED: Drop price changed from FREE (0.00 ETH) to ${newPriceEth} ETH!`);
                logger.error(`🛡️ ABORTING MINT IMMEDIATELY to protect wallet funds.`);
                throw new Error(`Bait & switch prevented: creator raised price on free drop to ${newPriceEth} ETH.`);
              }

              // Price increased above initially armed price
              if (freshDrop.mintPrice > armedPriceWei) {
                logger.error(`🚨 PRICE INCREASE DETECTED: Price increased from ${oldPriceEth} ETH to ${newPriceEth} ETH!`);
                logger.error(`🛡️ ABORTING MINT to prevent unexpected spend.`);
                throw new Error(`Price increase prevented: creator changed price from ${oldPriceEth} ETH to ${newPriceEth} ETH.`);
              }

              // Price decreased (safe price drop): Auto-update and re-sign
              logger.warn(`⚠️ On-chain price decreased: ${oldPriceEth} ETH -> ${newPriceEth} ETH. Auto-updating transactions...`);
              currentMintPriceWei = freshDrop.mintPrice;
              totalCostPerWalletWei = currentMintPriceWei * BigInt(quantity);
              dropParams.feeRecipient = freshDrop.feeRecipient;

              for (const p of validPrepared) {
                const calldata = encodeMintPublicCalldata(nftContractAddress, dropParams.feeRecipient, p.wallet.address, quantity);
                p.rawTxObj.data = calldata;
                p.rawTxObj.value = totalCostPerWalletWei;
                p.signedTx = await p.wallet.signTransaction(p.rawTxObj);
                p.rawBuffer = connectionManager.createRawBufferPayload(p.signedTx);
                await presignBackups(p);
              }
              logger.success(`Transactions updated to new price (${newPriceEth} ETH).`);
            }
          } catch (watchdogErr) {
            if (watchdogErr.message && watchdogErr.message.includes('prevented')) {
              throw watchdogErr;
            }
          }

          // 2. Nonce Refresh
          await WalletService.prefetchNonces(validPrepared.map(p => p.wallet), provider);
          for (const p of validPrepared) {
            try {
              const freshNonce = WalletService.consumeNonce(p.wallet.address) ?? await provider.getTransactionCount(p.wallet.address, 'pending');
              if (freshNonce !== p.nonce) {
                p.nonce = freshNonce;
                p.rawTxObj.nonce = freshNonce;
                p.signedTx = await p.wallet.signTransaction(p.rawTxObj);
                p.rawBuffer = connectionManager.createRawBufferPayload(p.signedTx);
                // The recovery ladder is nonce-relative, so it is invalid now.
                await presignBackups(p);
              }
            } catch (e) {}
          }
        }
      },
      {
        atMs: 5000,
        label: 'T-5s: DNS, socket warming & latency calibration',
        run: async () => {
          logger.info('T-5s: Pre-resolving DNS, warming persistent socket pool, and pre-serializing transaction buffers...');
          for (const p of validPrepared) {
            if (p.signedTx) {
              p.rawBuffer = connectionManager.createRawBufferPayload(p.signedTx);
            }
          }
          await Promise.all([
            connectionManager.preResolveDns(broadcaster.rpcUrls),
            connectionManager.preWarmSockets(broadcaster.rpcUrls)
          ]);

          // Calibrate the lead time against the endpoint we will actually write
          // to. The right lead is one one-way flight, so the transaction touches
          // the sequencer the instant the drop opens: fire later and a competitor
          // is ahead of us in the FIFO queue, fire earlier and the contract
          // reverts NotActive(). That distance is ~120ms from a home connection
          // and single-digit ms from a host in the sequencer's region, so it has
          // to be measured rather than assumed.
          const writeUrl = (broadcaster.endpoints[0] && broadcaster.endpoints[0].url) || null;
          const rttMs = await connectionManager.measureRoundTripMs(writeUrl, 5);
          const calibration = calibrateLeadTimeMs(rttMs);
          leadTimeMs = calibration.leadTimeMs;
          logger.speed(
            `Lead time set to ${leadTimeMs}ms (${calibration.source}) — ` +
            'trigger fires one network flight before the drop opens.'
          );
        }
      },
      {
        atMs: 2000,
        label: 'T-2s: Pre-flight simulation',
        run: async () => {
          if (!validPrepared[0] || !validPrepared[0].rawTxObj) return;
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
      },
      {
        // Final socket top-up and GC. Both have to happen BEFORE the spin loop:
        // the keep-alive pool is already hot from T-5s, so re-warming after the
        // trigger would spend a full round-trip and hand back the lead time we
        // just measured. The collection is here for the same reason — warmup
        // (signing, re-signing, buffers, DNS, simulation) has filled the young
        // generation, so the next allocation would trigger a scavenge, and the
        // next allocation is the broadcast. Taking the pause now costs nothing.
        atMs: 800,
        label: 'T-0.8s: Final socket top-up & GC quiesce',
        run: async () => {
          await connectionManager.preWarmSockets(broadcaster.rpcUrls);
          gcGuard.quiesce('T-0.8s');
        }
      }
    ],
    // The sequencer's clock is the only one that counts: if it has already
    // reached the on-chain start time, waiting any longer is pure loss.
    //
    // Prefer the feed. Reading the same fact with `getBlock('latest')` costs a
    // full round-trip (~240ms measured), so a polling check learns the drop
    // opened well after the fact — on a FIFO chain that lateness is the drop.
    // The feed pushes the sequencer's own timestamp with no request at all.
    earlyTrigger: onChainStartTime > 0 ? {
      withinMs: 2500,
      message: '⚡ Sequencer clock reached drop time! Launching instant blast...',
      check: async () => {
        if (feed && feed.hasReachedTimestamp(onChainStartTime)) return true;
        // Feed absent, or its clock went stale because the chain is idle.
        const block = await provider.getBlock('latest').catch(() => null);
        return !!(block && Number(block.timestamp) >= onChainStartTime);
      }
    } : null
  });

  // Multi-RPC FIFO Sequencer Packet Flood
  logger.speed(`>>> ⚡ FIRE! ${broadcaster.burstOffsets.length}-pulse micro-burst across ${broadcaster.rpcUrls.length} node(s) for ${validPrepared.length} wallet(s) (Lead: ${leadTimeMs}ms) <<<`);
  if (typeof config.onFiring === 'function') {
    try { config.onFiring(); } catch {}
  }
  if (dropTrigger.reason === 'spin' && dropTrigger.overshootMs > 5) {
    logger.warn(`Trigger overshot the target instant by ${dropTrigger.overshootMs}ms — warmup ran long.`);
  }
  const startTimeMs = Date.now();
  const totalWallets = validPrepared.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const broadcastPromises = validPrepared.map(async ({ wallet, signedTx, rawTxObj, rawBuffer, backups: backupTxs }) => {
    const walletStartMs = Date.now();
    let hasCounted = false;
    try {
      let broadcastResult;
      try {
        broadcastResult = await broadcaster.broadcastFlood(signedTx, rawBuffer);
      } catch (broadcastErr) {
        // Every endpoint rejected on every pulse. This used to be swallowed and
        // replaced with a locally computed hash, so the transaction *looked*
        // sent: the code below then waited the full 60s receipt timeout for
        // something that was never accepted, and the RPC's real complaint was
        // discarded. On a FIFO chain that silent minute is the whole drop, so
        // this now surfaces immediately with the actual reason.
        broadcastErr.stage = 'broadcast';
        throw broadcastErr;
      }
      logger.walletLine(wallet.address, 'Sent', `Fastest RPC: ${broadcastResult.fastestRpc} (${broadcastResult.durationMs}ms)`);

      const { receipt } = await broadcaster.waitForReceiptFastest(broadcastResult.txHash, 1, 60000);
      const mintDurationMs = Date.now() - walletStartMs;
      const latencyMs = Date.now() - startTimeMs;

      if (receipt && receipt.status === 1) {
        hasCounted = true;
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
          address: wallet.address,
          wallet,
          receipt,
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

        // --- MICRO-BURST AUTO-RETRY ON TIMING DRIFT (NotActive) ---
        const isNotActiveError = (customError && customError.includes('NotActive')) ||
                                 (decodedDetails && decodedDetails.toLowerCase().includes('notactive'));

        if (isNotActiveError) {
          logger.warn(`[${wallet.address.slice(0, 6)}...] Drop not active yet (arrived a block early). Firing pre-signed recovery ladder...`);

          // No delay before the first retry, and no signing or nonce lookup:
          // simply discovering this revert already cost a receipt round-trip
          // (~240ms, ~3 blocks at this chain's rate), so every further
          // millisecond is queue position handed to someone else. The old ladder
          // slept 350ms first and then re-signed, which put the retry roughly 8
          // blocks behind the open — long after a 50-supply drop is gone.
          //
          // Later rungs are spaced by one block interval, which is the only wait
          // that can change the answer: NotActive can only clear when the
          // sequencer builds a block with a newer timestamp.
          const retryDelaysMs = [0, 120, 120];
          const backups = backupTxs || [];

          for (let attempt = 0; attempt < retryDelaysMs.length && attempt < backups.length; attempt++) {
            if (retryDelaysMs[attempt] > 0) {
              await new Promise(r => setTimeout(r, retryDelaysMs[attempt]));
            }
            const backup = backups[attempt];
            try {
              logger.speed(`[${wallet.address.slice(0, 6)}...] Recovery burst #${attempt + 1} firing (pre-signed, nonce ${backup.nonce})...`);

              const retryBroadcast = await broadcaster.broadcastFastest(backup.signedTx, backup.rawBuffer);
              const retryWait = await broadcaster.waitForReceiptFastest(retryBroadcast.txHash, 1, 30000);

              if (retryWait.receipt && retryWait.receipt.status === 1) {
                hasCounted = true;
                completedCount++;
                successCount++;
                const retryDurationMs = Date.now() - walletStartMs;
                logger.mintProgress(completedCount, totalWallets, successCount, failCount);
                logger.walletLine(wallet.address, 'SUCCESS', `Block #${retryWait.receipt.blockNumber} (Burst #${attempt + 1} succeeded in ${retryDurationMs}ms)`);

                Notifier.sendMintAlert({
                  address: wallet.address,
                  status: 'SUCCESS',
                  txHash: retryBroadcast.txHash,
                  explorerUrl,
                  contractAddress: nftContractAddress,
                  latencyMs: Date.now() - startTimeMs,
                  blockNumber: retryWait.receipt.blockNumber
                });

                return {
                  timestamp: new Date().toISOString(),
                  formattedTime: new Date().toLocaleString(),
                  network: chainConfig?.name || network.name,
                  contractAddress: nftContractAddress,
                  walletAddress: wallet.address,
                  address: wallet.address,
                  wallet,
                  receipt: retryWait.receipt,
                  maskedAddress: `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`,
                  mode: 'PUBLIC',
                  quantity,
                  status: 'SUCCESS',
                  txHash: retryBroadcast.txHash,
                  blockNumber: Number(retryWait.receipt.blockNumber),
                  gasUsed: retryWait.receipt.gasUsed?.toString(),
                  gasPriceGwei: retryWait.receipt.gasPrice ? ethers.formatUnits(retryWait.receipt.gasPrice, 'gwei') : null,
                  mintDurationMs: retryDurationMs,
                  details: `Block #${retryWait.receipt.blockNumber} (Burst #${attempt + 1} in ${retryDurationMs}ms)`,
                  revertReason: null
                };
              }
            } catch (retryErr) {
              // Continue to next burst attempt
            }
          }
        }

        if (!hasCounted) {
          hasCounted = true;
          completedCount++;
          failCount++;
          logger.mintProgress(completedCount, totalWallets, successCount, failCount);
        }
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
      if (!hasCounted) {
        hasCounted = true;
        completedCount++;
        failCount++;
        logger.mintProgress(completedCount, totalWallets, successCount, failCount);
      }

      const friendlyMsg = formatError(error);
      if (error.stage === 'broadcast') {
        logger.walletLine(wallet.address, 'REJECTED', `No endpoint accepted the tx — ${error.message}`);
      } else {
        logger.walletLine(wallet.address, 'ERROR', friendlyMsg);
        logger.warn(`  Technical detail: ${error.message}`);
      }

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

  // Post-Mint Disposition: Auto-Sell to Top Offer OR Auto-Forward to Recipient
  const successfulResults = results.filter(r => r.status === 'SUCCESS' && r.txHash);
  if (successfulResults.length > 0) {
    if (config.postMintConfig?.action === 'TOP_OFFER') {
      await SeaportOfferEngine.executeOfferFulfillment({
        results: successfulResults,
        wallets,
        provider,
        nftContractAddress,
        collectionSlug: config.collectionSlug,
        postMintConfig: config.postMintConfig,
        explorerUrl
      });
    } else if (recipientAddress || config.postMintConfig?.action === 'RECIPIENT') {
      const targetRecipient = recipientAddress || config.postMintConfig?.recipientAddress;
      if (targetRecipient) {
        await forwardNFTs(successfulResults, wallets, provider, targetRecipient, explorerUrl);
      }
    }
  }

  // Non-blocking async history recording with timestamps & session duration
  const historyResults = results.map(r => ({
    ...r,
    totalSessionDurationMs: totalSessionMs
  }));
  try {
    for (const r of historyResults) {
      await MintTracker.recordMint(r);
    }
  } catch (e) {}

  return results;
}

/**
 * Public mint entry point.
 *
 * Thin wrapper so the sequencer feed is always torn down: it holds an open
 * WebSocket, which would otherwise keep the process alive after the CLI prints
 * its summary, and there are several early `throw` paths above it.
 *
 * @param {object} config
 * @returns {Promise<object[]>}
 */
async function runPublicMint(config) {
  const state = {};
  try {
    return await executePublicMint(config, state);
  } finally {
    if (state.feed) {
      try { state.feed.close(); } catch (e) {}
    }
  }
}

module.exports = { runPublicMint };
