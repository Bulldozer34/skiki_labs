const { ethers } = require('ethers');
const { getChainKey } = require('../utils/chains');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');
const { forwardNFTs } = require('./nftForwarder');
const SeaportOfferEngine = require('../services/seaportOfferEngine');
const MultiRpcBroadcaster = require('./multiRpcBroadcaster');
const PreflightSimulator = require('./preflightSimulator');
const connectionManager = require('../services/connectionManager');
const authService = require('../services/authService');
const WalletService = require('../services/walletService');
const { formatError } = require('../utils/errorTranslator');
const { mintHistoryWriter } = require('../utils/asyncWriter');
const MintTracker = require('../core/mintTracker');
const { resolveGasFees, formatGasSelection } = require('../utils/gasEstimator');
const { waitForDropWindow, resolveLeadTimeMs, calibrateLeadTimeMs } = require('../core/dropClock');
const gcGuard = require('../core/gcGuard');
const { SequencerFeed } = require('../services/sequencerFeed');
const { getAllowListDropParams, SEADROP_ADDRESSES } = require('../contracts/seadrop');

/**
 * Validate calldata price against armed expectations
 * Note: MAX_MINT_ETH ceiling is strictly for Copy-Mint only. For Allowlist drops,
 * the operator explicitly specifies the drop, so this watchdog protects against
 * unauthorized Bait & Switch (Free -> Paid) and price hikes.
 * @param {bigint} calldataValueWei 
 * @param {bigint|null} expectedPriceWei 
 * @param {boolean|null} expectedIsFree 
 */
function validateAllowlistPrice(calldataValueWei, expectedPriceWei, expectedIsFree) {
  const valueEth = ethers.formatEther(calldataValueWei);

  // 1. Bait & Switch: Expected Free -> Raised to Paid
  if (expectedIsFree === true && calldataValueWei > 0n) {
    throw new Error(`Bait & switch prevented: creator raised allowlist price from FREE (0.00 ETH) to ${valueEth} ETH.`);
  }

  // 2. Price Increase: Raised above expected paid price
  if (expectedPriceWei !== null && expectedPriceWei > 0n && calldataValueWei > expectedPriceWei) {
    const oldPriceEth = ethers.formatEther(expectedPriceWei);
    throw new Error(`Price increase prevented: creator raised allowlist price from ${oldPriceEth} ETH to ${valueEth} ETH.`);
  }

  // 3. Paid -> Free (Price Drop)
  if (expectedPriceWei !== null && expectedPriceWei > 0n && calldataValueWei === 0n) {
    return { status: 'PRICE_DROPPED_TO_FREE', valueWei: 0n };
  }

  return { status: 'NORMAL', valueWei: calldataValueWei };
}

let openseaApiKeyIndex = 0;
function getOpenSeaApiKeys() {
  const raw = [
    process.env.OPENSEA_API_KEY,
    process.env.OPENSEA_API_KEY_2,
    process.env.OPENSEA_API_KEY_3,
    process.env.OPENSEA_KEY,
    process.env.OPENSEA_KEYS
  ].filter(Boolean);

  const keys = [];
  for (const item of raw) {
    for (const key of String(item).split(/[\s,]+/)) {
      const clean = key.trim();
      if (clean && !keys.includes(clean)) keys.push(clean);
    }
  }
  return keys;
}

function getNextOpenSeaApiKey() {
  const keys = getOpenSeaApiKeys();
  if (keys.length === 0) return '';
  const key = keys[openseaApiKeyIndex % keys.length];
  openseaApiKeyIndex++;
  return key;
}

function getOpenSeaApiKey() {
  return getNextOpenSeaApiKey();
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
async function fetchSingleCalldata(wallet, config, authHeaders, requestTimeout = 8000, specificApiKey = null) {
  const { quantity } = config;
  const apiKey = specificApiKey || getNextOpenSeaApiKey();
  const slug = getDropSlug(config);

  if (!slug) {
    throw new Error('Collection identifier is required to fetch drop mint data.');
  }

  let safeQuantity = Math.max(1, Math.floor(Number(quantity) || 1));
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

  try {
    const res = await connectionManager.axiosInstance.post(url, {
      minter: ethers.getAddress(wallet.address),
      quantity: safeQuantity
    }, {
      headers,
      timeout: requestTimeout
    });

    return normalizeOpenSeaMintTransaction(res.data);
  } catch (error) {
    const apiMsg = String(error.response?.data?.message || error.response?.data?.detail || error.message).toLowerCase();

    // Dynamic Quota Auto-Sensing: If quantity > 1 and error mentions quota/allocation, auto-clamp to 1
    if (safeQuantity > 1 && (apiMsg.includes('allocation') || apiMsg.includes('quota') || apiMsg.includes('max') || apiMsg.includes('quantity'))) {
      logger.warn(`[${wallet.address.slice(0, 6)}...] Allocation quota exceeded for quantity ${safeQuantity}. Auto-clamping to 1...`);
      safeQuantity = 1;
      const retryRes = await connectionManager.axiosInstance.post(url, {
        minter: ethers.getAddress(wallet.address),
        quantity: 1
      }, {
        headers,
        timeout: requestTimeout
      });
      return normalizeOpenSeaMintTransaction(retryRes.data);
    }

    // Rate Limit 429 Failover: Try next available API key
    if (error.response?.status === 429) {
      const backupKey = getNextOpenSeaApiKey();
      if (backupKey && backupKey !== apiKey) {
        headers['x-api-key'] = backupKey;
        const retryRes = await connectionManager.axiosInstance.post(url, {
          minter: ethers.getAddress(wallet.address),
          quantity: safeQuantity
        }, {
          headers,
          timeout: requestTimeout
        });
        return normalizeOpenSeaMintTransaction(retryRes.data);
      }
    }

    throw error;
  }
}

/**
 * Fetch calldata concurrently for all session wallets with distributed multi-key pipelining
 */
async function fetchAllCalldata(wallets, config, authHeadersByAddress, fallbackAuthHeaders, requestTimeout = 8000) {
  const calldataMap = new Map();
  const keys = getOpenSeaApiKeys();

  const settled = await Promise.allSettled(wallets.map(async (wallet, idx) => {
    const assignedKey = keys.length > 0 ? keys[idx % keys.length] : null;
    try {
      const headers = authHeadersByAddress.get(wallet.address.toLowerCase()) || fallbackAuthHeaders;
      const data = await fetchSingleCalldata(wallet, config, headers, requestTimeout, assignedKey);
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
 * @param {object} config
 * @param {{feed?: import('../services/sequencerFeed').SequencerFeed}} state
 *   Resources the caller must tear down regardless of how this returns.
 */
async function executeAllowlistMint(config, state) {
  const { wallets, provider, rpcUrls, endpoints, feedUrl, nftContractAddress, chain: chainConfig, quantity, gasSettings, recipientAddress } = config;
  const chain = chainConfig;
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

  // Sequencer feed first, so the broadcaster reports inclusion from the push
  // stream instead of polling, and the trigger can read the sequencer's own
  // clock without spending a round-trip.
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

  // Pre-check balances for gas & potential mint value
  const initialGasFees = await ensureGasFees();
  const minRequiredGasWei = initialGasFees.maxFeePerGas * BigInt(gasSettings.gasLimit || 300000);
  for (const wallet of wallets) {
    try {
      const bal = await provider.getBalance(wallet.address);
      if (bal < minRequiredGasWei) {
        logger.warn(`Wallet ${wallet.address.slice(0, 6)}... has low ETH balance: ${ethers.formatEther(bal)} ETH (Est. Gas needed: ${ethers.formatEther(minRequiredGasWei)} ETH)`);
      }
    } catch (e) {}
  }

  // Pre-fetch nonces
  let nonceMap = await WalletService.prefetchNonces(wallets, provider);

  // 0. Discover on-chain allowlist stage parameters if on SeaDrop
  const seadropAddr = SEADROP_ADDRESSES[chainKey] || chainConfig.seadropAddress;
  let armedPriceWei = null;
  let isFreeMint = null;
  if (seadropAddr && nftContractAddress) {
    try {
      const onChainDrop = await getAllowListDropParams(provider, seadropAddr, nftContractAddress);
      if (onChainDrop) {
        armedPriceWei = onChainDrop.mintPrice;
        isFreeMint = (armedPriceWei === 0n);
        const priceEth = ethers.formatEther(armedPriceWei);
        logger.info(`On-chain Allowlist Stage: Price = ${priceEth} ETH (Max Mintable: ${onChainDrop.maxTotalMintableByWallet})`);
      }
    } catch (e) {}
  }

  let calldataMap = new Map();
  let calldataFetchedAtMs = 0;
  let preparedTxs = null;
  let gasFees = null;
  const deadlineMs = startTime ? startTime * 1000 : 0;
  // Replaced at T-5s by a value measured on the live write path, unless the
  // operator pinned SNIPER_LEAD_TIME_MS.
  let leadTimeMs = resolveLeadTimeMs();

  const fetchCalldata = (timeoutMs) =>
    fetchAllCalldata(wallets, config, authHeadersByAddress, fallbackAuthHeaders, timeoutMs);

  /** Resolve gas once, honouring the preset chosen in the CLI. */
  const ensureGasFees = async () => {
    if (!gasFees) {
      gasFees = await resolveGasFees(provider, gasSettings);
      logger.gasEstimate(formatGasSelection(gasFees));
    }
    return gasFees;
  };

  const runPreflightSimulation = async () => {
    const firstWalletAddr = Array.from(calldataMap.keys())[0];
    const firstCalldata = firstWalletAddr ? calldataMap.get(firstWalletAddr) : null;
    if (!firstCalldata) return;

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
  };

  /**
   * Pre-sign the `NotActive()` recovery ladder for one wallet.
   *
   * A revert still consumes the nonce, so recovery needs nonce+1, nonce+2, and
   * signing them at revert time is the worst possible moment: learning about the
   * revert already cost a receipt round-trip, and a nonce lookup plus a signature
   * costs another. The OpenSea signed-mint signature covers the minter, quantity
   * and drop params — not the nonce — so the same calldata stays valid.
   *
   * @param {object} prepared
   * @param {number} baseNonce
   * @param {number} [depth]
   */
  const presignBackups = async (prepared, baseNonce, depth = 3) => {
    prepared.backups = [];
    for (let i = 1; i <= depth; i++) {
      try {
        const txObj = { ...prepared.rawTxObj, nonce: baseNonce + i };
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

  /**
   * Sign every eligible wallet offline and pre-serialize its JSON-RPC buffer.
   * Runs before the trigger whenever calldata arrived in time, so the spin loop
   * releases straight into a broadcast with no signing left to do.
   */
  const presignAll = async () => {
    const fees = await ensureGasFees();
    logger.info('Pre-signing transactions offline...');

    // Price Watchdog: Validate price across all fetched calldata before signing
    for (const [addr, calldata] of calldataMap.entries()) {
      const calldataVal = BigInt(calldata.value || 0);
      try {
        const valRes = validateAllowlistPrice(calldataVal, armedPriceWei, isFreeMint);
        if (valRes.status === 'PRICE_DROPPED_TO_FREE') {
          calldata.value = '0';
        }
      } catch (priceErr) {
        logger.error(`🚨 PRICE WATCHDOG TRIGGERED: ${priceErr.message}`);
        Notifier.sendAlert(`🚨 **Security Alert (Allowlist Mint Aborted)**\n${priceErr.message}`);
        throw priceErr;
      }
    }

    const prepared = await Promise.all(wallets.map(async (wallet) => {
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
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          nonce: nonce,
          chainId: network.chainId,
          type: 2
        };

        const signedTx = await wallet.signTransaction(tx);
        return { wallet, signedTx, rawTxObj: tx, nonce, error: null };
      } catch (err) {
        return { wallet, signedTx: null, rawTxObj: null, error: err.message };
      }
    }));

    // Pre-generate binary JSON-RPC buffers for zero runtime serialization, then
    // the recovery ladder, so a NotActive revert is answered by a pure send.
    for (const p of prepared) {
      if (p.signedTx) {
        p.rawBuffer = connectionManager.createRawBufferPayload(p.signedTx);
      }
    }
    await Promise.all(
      prepared.filter(p => p.signedTx).map(p => presignBackups(p, p.nonce))
    );

    return prepared;
  };

  // --- UNIFIED CONTINUOUS WARMUP & HIGH-PRECISION SPIN-LOOP PIPELINE ---
  const dropTrigger = await waitForDropWindow({
    deadlineMs,
    leadTimeMs: () => leadTimeMs,
    label: 'Allowlist mint',
    milestones: [
      {
        atMs: 30000,
        label: 'T-30s: Pre-flight eligibility probe',
        run: async () => {
          logger.info('T-30s: Probing allowlist eligibility across session wallets...');
          try {
            const earlyCheck = await fetchCalldata(1500);
            if (earlyCheck && earlyCheck.size > 0) {
              logger.success(`Eligibility verified early for ${earlyCheck.size}/${wallets.length} wallet(s).`);
              for (const [addr, data] of earlyCheck) {
                calldataMap.set(addr, data);
              }
            }
          } catch (e) {}
        }
      },
      {
        atMs: 15000,
        label: 'T-15s: Refreshing nonces & verifying allowlist price integrity',
        run: async () => {
          logger.info('T-15s: Refreshing wallet nonces and verifying allowlist price...');
          nonceMap = await WalletService.prefetchNonces(wallets, provider);

          if (seadropAddr && nftContractAddress) {
            try {
              const freshDrop = await getAllowListDropParams(provider, seadropAddr, nftContractAddress);
              if (freshDrop && armedPriceWei !== null && freshDrop.mintPrice !== armedPriceWei) {
                const oldPriceEth = ethers.formatEther(armedPriceWei);
                const newPriceEth = ethers.formatEther(freshDrop.mintPrice);

                // Bait & switch check: Free -> Paid
                if (isFreeMint && freshDrop.mintPrice > 0n) {
                  logger.error(`🚨 BAIT & SWITCH DETECTED: Allowlist drop price changed from FREE (0.00 ETH) to ${newPriceEth} ETH!`);
                  Notifier.sendAlert(`🚨 **Bait & Switch Prevented on Allowlist!**\nCreator changed price from FREE to **${newPriceEth} ETH**.\nMint aborted to protect wallets.`);
                  throw new Error(`Bait & switch prevented: creator raised allowlist price on free drop to ${newPriceEth} ETH.`);
                }

                // Price increased
                if (freshDrop.mintPrice > armedPriceWei) {
                  logger.error(`🚨 PRICE INCREASE DETECTED: Allowlist price increased from ${oldPriceEth} ETH to ${newPriceEth} ETH!`);
                  Notifier.sendAlert(`🚨 **Price Increase Prevented on Allowlist!**\nCreator raised price from ${oldPriceEth} ETH to **${newPriceEth} ETH**.\nMint aborted.`);
                  throw new Error(`Price increase prevented: creator changed allowlist price from ${oldPriceEth} ETH to ${newPriceEth} ETH.`);
                }

                // Price decreased
                logger.warn(`⚠️ On-chain allowlist price decreased: ${oldPriceEth} ETH -> ${newPriceEth} ETH. Updating armed price...`);
                armedPriceWei = freshDrop.mintPrice;
                isFreeMint = (armedPriceWei === 0n);
              }
            } catch (err) {
              if (err.message.includes('prevented')) throw err;
            }
          }
        }
      },
      {
        atMs: 5000,
        label: 'T-5s: DNS, socket warming & latency calibration',
        run: async () => {
          logger.info('T-5s: Pre-resolving DNS, warming sockets, and calibrating lead time...');
          const targets = ['https://api.opensea.io', ...broadcaster.rpcUrls];
          await Promise.all([
            connectionManager.preResolveDns(targets),
            connectionManager.preWarmSockets(targets)
          ]);

          // Calibrate the lead time against the endpoint we will actually write
          // to. The right lead is one one-way flight, so the transaction touches
          // the sequencer the instant the drop opens.
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
        atMs: 3000,
        label: 'T-3s: Calldata hammer',
        run: async () => {
          logger.speed('T-3s: Hammering OpenSea Drops API for calldata (1.5s timeout)...');
          // Extended post-deadline window: OpenSea may delay publishing calldata
          // up to 5s after the drop starts on overloaded drops.
          const hammerEnd = deadlineMs + 5000;
          let hammerAttempt = 0;
          while (Date.now() < hammerEnd && calldataMap.size === 0) {
            hammerAttempt++;
            try {
              calldataMap = await fetchCalldata(1500);
              if (calldataMap.size > 0) {
                logger.success(`Early calldata acquired for ${calldataMap.size} wallet(s) on attempt #${hammerAttempt}!`);
                break;
              }
            } catch (err) {}
            await new Promise(r => setTimeout(r, 100));
          }

          // Second wave: if we got partial results (some wallets eligible, some
          // not yet), retry the missing ones before giving up.
          if (calldataMap.size > 0 && calldataMap.size < wallets.length) {
            const missingWallets = wallets.filter(w => !calldataMap.has(w.address.toLowerCase()));
            if (missingWallets.length > 0) {
              logger.info(`Second-wave fetch for ${missingWallets.length} wallet(s) that didn't get calldata yet...`);
              try {
                const secondWave = await fetchAllCalldata(missingWallets, config, authHeadersByAddress, fallbackAuthHeaders, 2000);
                for (const [addr, data] of secondWave) {
                  calldataMap.set(addr, data);
                }
                if (secondWave.size > 0) {
                  logger.success(`Second wave acquired calldata for ${secondWave.size} more wallet(s). Total: ${calldataMap.size}/${wallets.length}`);
                }
              } catch (err) {}
            }
          }

          if (calldataMap.size === 0 && hammerAttempt > 0) {
            logger.warn(`Hammer phase: ${hammerAttempt} attempts, no calldata yet — will retry after deadline`);
          }

          // Track when calldata was acquired for staleness check
          if (calldataMap.size > 0) {
            calldataFetchedAtMs = Date.now();
          }
        }
      },
      {
        // Anything costing a network round-trip has to be done before the spin
        // loop, or the lead time gets spent on a gas lookup instead of travel.
        atMs: 2000,
        label: 'T-2s: Gas estimate & pre-flight simulation',
        run: async () => {
          if (calldataMap.size === 0) return;
          await ensureGasFees();
          await runPreflightSimulation();
        }
      },
      {
        atMs: 900,
        label: 'T-0.9s: Pre-signing & final socket top-up',
        run: async () => {
          if (calldataMap.size === 0) return;
          preparedTxs = await presignAll();
          await connectionManager.preWarmSockets(broadcaster.rpcUrls);
        }
      },
      {
        // Final GC before the spin loop. Warmup (signing, re-signing, buffers,
        // DNS, simulation) has filled the young generation, so the next
        // allocation would trigger a scavenge — and the next allocation is the
        // broadcast. Taking the pause now costs nothing.
        atMs: 800,
        label: 'T-0.8s: GC quiesce',
        run: async () => {
          gcGuard.quiesce('T-0.8s');
        }
      }
    ],
    // The sequencer's clock is the only one that counts: if it has already
    // reached the on-chain start time, waiting any longer is pure loss.
    earlyTrigger: startTime && startTime > 0 ? {
      withinMs: 2500,
      message: '⚡ Sequencer clock reached drop time! Launching instant blast...',
      check: async () => {
        if (feed && feed.hasReachedTimestamp(startTime)) return true;
        const block = await provider.getBlock('latest').catch(() => null);
        return !!(block && Number(block.timestamp) >= startTime);
      }
    } : null
  });

  // Slow path — the drop was already live, or calldata never arrived before the
  // trigger. Everything the warmup ladder skipped happens here instead.
  if (!preparedTxs) {
    if (calldataMap.size === 0) {
      logger.info('Fetching mint calldata via OpenSea Drops API...');
      calldataMap = await fetchCalldata();
      calldataFetchedAtMs = Date.now();
    }

    // Stale calldata guard: if calldata was fetched during the T-3s hammer but
    // is now >10s old, re-fetch once. OpenSea signed mint data can expire, and
    // the drop parameters may have changed between the pre-fetch and now.
    if (calldataMap.size > 0 && calldataFetchedAtMs > 0 && (Date.now() - calldataFetchedAtMs) > 10000) {
      logger.info('Calldata is stale (>10s old) — re-fetching for freshness...');
      try {
        const freshMap = await fetchCalldata(3000);
        if (freshMap.size > 0) {
          calldataMap = freshMap;
          calldataFetchedAtMs = Date.now();
          logger.success(`Fresh calldata acquired for ${calldataMap.size} wallet(s).`);
        }
      } catch (err) {
        logger.warn('Stale re-fetch failed — proceeding with existing calldata.');
      }
    }

    logger.info(`Valid calldata acquired for ${calldataMap.size}/${wallets.length} wallet(s).`);

    if (calldataMap.size === 0) {
      logger.warn('Tip: If this is an OpenSea SeaDrop contract, select "Public Mint (Direct SeaDrop Contract)" mode to mint directly on-chain.');
      throw new Error('Could not obtain calldata for any wallet. Check drop live status, wallet eligibility, or use Direct SeaDrop Mint.');
    }

    await runPreflightSimulation();
    preparedTxs = await presignAll();

    // Re-warm sockets right before firing to ensure TCP/TLS is hot
    await connectionManager.preWarmSockets(broadcaster.rpcUrls);
  } else {
    logger.info(`Valid calldata acquired for ${calldataMap.size}/${wallets.length} wallet(s).`);
  }

  // 6. Parallel Multi-RPC 5-Pulse Burst Broadcast
  logger.speed(`>>> ⚡ FIRE! 5-Pulse Micro-Burst Storm across ${broadcaster.rpcUrls.length} RPC node(s) (Lead: ${leadTimeMs}ms) <<<`);
  if (dropTrigger.reason === 'spin' && dropTrigger.overshootMs > 5) {
    logger.warn(`Trigger overshot the target instant by ${dropTrigger.overshootMs}ms — warmup ran long.`);
  }
  const startTimeMs = Date.now();
  const totalWallets = wallets.length;
  let completedCount = 0;
  let successCount = 0;
  let failCount = 0;

  const txPromises = preparedTxs.map(async ({ wallet, signedTx, rawTxObj, rawBuffer, backups: backupTxs, error }) => {
    let hasCounted = false;
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
      let broadcastResult;
      try {
        broadcastResult = await broadcaster.broadcastFlood(signedTx, rawBuffer);
      } catch (broadcastErr) {
        // Every endpoint rejected on every pulse. Surface immediately with the
        // actual reason instead of silently waiting 60s for a receipt that will
        // never arrive.
        broadcastErr.stage = 'broadcast';
        throw broadcastErr;
      }
      logger.walletLine(wallet.address, 'Sent', `Fastest: ${broadcastResult.fastestRpc} (${broadcastResult.durationMs}ms)`);

      const { receipt } = await broadcaster.waitForReceiptFastest(broadcastResult.txHash, 1, 60000);
      const mintDurationMs = Date.now() - walletStartMs;
      const latencyMs = Date.now() - startTimeMs;

      if (receipt && receipt.status === 1) {
        hasCounted = true;
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
          address: wallet.address,
          wallet,
          receipt,
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

        // --- MICRO-BURST AUTO-RETRY ON TIMING DRIFT (NotActive) ---
        const isNotActiveError = (customError && customError.includes('NotActive')) ||
                                 (decodedDetails && decodedDetails.toLowerCase().includes('notactive'));

        if (isNotActiveError) {
          logger.warn(`[${wallet.address.slice(0, 6)}...] Drop not active yet (arrived a block early). Firing pre-signed recovery ladder...`);

          // No delay before the first retry: discovering the revert already cost
          // a receipt round-trip (~240ms). The OpenSea signed-mint signature
          // covers the minter, quantity and drop params — not the nonce — so the
          // same calldata stays valid across retries.
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
                  mode: 'ALLOWLIST',
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

  // 6. Post-Mint Disposition: Auto-Sell to Top Offer OR Auto-Forward to Recipient
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
 * Allowlist mint entry point.
 *
 * Thin wrapper so the sequencer feed is always torn down: it holds an open
 * WebSocket, which would otherwise keep the process alive after the CLI prints
 * its summary, and there are several early `throw` paths above it.
 *
 * @param {object} config
 * @returns {Promise<object[]>}
 */
async function runAllowlistMint(config) {
  const state = {};
  try {
    return await executeAllowlistMint(config, state);
  } finally {
    if (state.feed) {
      try { state.feed.close(); } catch (e) {}
    }
  }
}

module.exports = {
  runAllowlistMint,
  fetchSingleCalldata,
  normalizeOpenSeaMintTransaction,
  validateAllowlistPrice,
  getOpenSeaApiKeys
};
