/**
 * Tracker Engine — Real-time Mempool (WebSocket) & Confirmed Block (HTTP) Whale Tracker.
 *
 * Monitors blockchain activity for transactions originating from registered whale addresses.
 * When a whale initiates an NFT mint, it captures the transaction data, parses it, and fires
 * an execution trigger.
 *
 * Adapted from ultra-dads-copy-mint-bot architecture.
 */

const { EventEmitter } = require('events');
const { ethers } = require('ethers');
const logger = require('../utils/logger');
const dedupeStore = require('./dedupeStore');
const { classifyMintTransaction } = require('./mintClassifier');
const trackedWalletService = require('../services/trackedWalletService');

class TrackerEngine extends EventEmitter {
  /**
   * @param {object} options
   * @param {ethers.Provider} options.httpProvider - HTTP RPC provider
   * @param {string} [options.wsRpcUrl] - Optional WebSocket RPC URL for mempool pending stream
   * @param {number} [options.chainId] - Network chain ID
   * @param {boolean} [options.enablePending=true] - Enable mempool pending detection
   * @param {boolean} [options.copyUnknownCalls=false] - Allow unknown selectors
   * @param {number} [options.bootGraceMs=5000] - Skip historical blocks on startup
   */
  constructor(options = {}) {
    super();
    this.httpProvider = options.httpProvider;
    this.wsRpcUrl = options.wsRpcUrl || process.env.WS_RPC_URL || null;
    this.chainId = options.chainId || 1;
    this.enablePending = options.enablePending !== false;
    this.copyUnknownCalls = Boolean(options.copyUnknownCalls || process.env.COPY_UNKNOWN_MINT_CALLS === 'true');
    this.bootGraceMs = options.bootGraceMs || 5000;

    this.wsProvider = null;
    this.isRunning = false;
    this.lastProcessedBlock = 0;
    this.headSynced = false;
    this.bootGraceUntil = 0;

    // Rate Limiting & Health Stats
    this.stats = {
      pendingSeen: 0,
      blocksSeen: 0,
      mintsDetected: 0,
      duplicatesSkipped: 0,
      nonMintsRejected: 0,
      wsConnected: false,
      wsReconnects: 0,
      lastDetectionTime: 0
    };

    this._pendingHandler = null;
    this._blockHandler = null;
    this._reconnectTimer = null;
  }

  /**
   * Start listening for tracked wallet transactions
   */
  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.bootGraceUntil = Date.now() + this.bootGraceMs;

    logger.info(`[Tracker] Starting whale tracker (Boot grace: ${this.bootGraceMs}ms)...`);

    // 1. Sync chain head
    try {
      this.lastProcessedBlock = await this.httpProvider.getBlockNumber();
      this.headSynced = true;
      logger.info(`[Tracker] Synced head @ block #${this.lastProcessedBlock}`);
    } catch (err) {
      logger.warn(`[Tracker] Initial block sync warning: ${err.message}`);
    }

    // 2. Start WebSocket Mempool if available
    if (this.wsRpcUrl && this.enablePending) {
      await this._connectWebSocket();
    }

    // 3. Start HTTP Block Poller (primary or fallback)
    this._startBlockPolling();

    const trackedCount = trackedWalletService.getActiveAddressesSet().size;
    logger.success(`[Tracker] Active. Monitoring ${trackedCount} whale wallet(s).`);
  }

  /**
   * Stop tracker and cleanup listeners
   */
  stop() {
    this.isRunning = false;

    if (this.wsProvider) {
      this.wsProvider.removeAllListeners();
      try {
        this.wsProvider.destroy();
      } catch {}
      this.wsProvider = null;
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this._blockHandler) {
      this.httpProvider.off('block', this._blockHandler);
      this._blockHandler = null;
    }

    this.stats.wsConnected = false;
    logger.info('[Tracker] Whale tracker stopped.');
  }

  // ─── WebSocket Mempool Handler ──────────────────────────────────
  async _connectWebSocket() {
    if (!this.wsRpcUrl) return;

    try {
      logger.info(`[Tracker/WS] Connecting to WebSocket RPC...`);
      this.wsProvider = new ethers.WebSocketProvider(this.wsRpcUrl);

      await this.wsProvider.ready;
      this.stats.wsConnected = true;
      logger.success(`[Tracker/WS] WebSocket connected. Subscribing to mempool pending txs...`);

      // Bounded concurrency pool for pending transaction lookups (max 6 parallel)
      let activeLookups = 0;
      const lookupQueue = [];

      const drainQueue = async () => {
        while (lookupQueue.length > 0 && activeLookups < 6) {
          const hash = lookupQueue.shift();
          activeLookups++;
          this._processPendingTx(hash)
            .catch(() => {})
            .finally(() => {
              activeLookups--;
              if (lookupQueue.length > 0) drainQueue();
            });
        }
      };

      this._pendingHandler = (txOrHash) => {
        if (!this.isRunning) return;
        this.stats.pendingSeen++;

        // If provider pushed full transaction object directly (e.g. Alchemy/filtered stream)
        if (typeof txOrHash === 'object' && txOrHash !== null && txOrHash.from) {
          this._handleTransactionObject(txOrHash, 'mempool');
          return;
        }

        // Standard hash stream: push to rate-limited queue
        if (typeof txOrHash === 'string') {
          if (lookupQueue.length < 50) {
            lookupQueue.push(txOrHash);
            drainQueue();
          }
        }
      };

      // Check if Alchemy filtered subscription is available
      const isAlchemy = this.wsRpcUrl.includes('alchemy.com');
      const trackedAddresses = Array.from(trackedWalletService.getActiveAddressesSet());

      if (isAlchemy && trackedAddresses.length > 0) {
        try {
          // Subscribe with server-side address filter (zero wasted getTransaction RPC calls!)
          await this.wsProvider.send('eth_subscribe', [
            'alchemy_pendingTransactions',
            { fromAddress: trackedAddresses }
          ]);
          logger.success(`[Tracker/WS] Active Alchemy server-side filtered stream for ${trackedAddresses.length} whale wallet(s)!`);
        } catch {
          this.wsProvider.on('pending', this._pendingHandler);
        }
      } else {
        this.wsProvider.on('pending', this._pendingHandler);
      }

      // Listen for WebSocket disconnect
      if (this.wsProvider.websocket) {
        this.wsProvider.websocket.onclose = () => {
          logger.warn('[Tracker/WS] WebSocket connection closed. Scheduling reconnect...');
          this.stats.wsConnected = false;
          this._scheduleWsReconnect();
        };
        this.wsProvider.websocket.onerror = () => {
          this.stats.wsConnected = false;
        };
      }
    } catch (err) {
      logger.warn(`[Tracker/WS] Connection failed: ${err.message}. Relying on HTTP block polling.`);
      this.stats.wsConnected = false;
      this._scheduleWsReconnect();
    }
  }

  _scheduleWsReconnect() {
    if (!this.isRunning || !this.wsRpcUrl || this._reconnectTimer) return;
    this.stats.wsReconnects++;
    const delay = Math.min(2000 * Math.pow(1.5, this.stats.wsReconnects), 30000);

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.isRunning) {
        await this._connectWebSocket();
      }
    }, delay);
  }

  _handleTransactionObject(tx, source = 'mempool', blockNumber = null) {
    if (!tx || !tx.from || !tx.to) return;
    const trackedSet = trackedWalletService.getActiveAddressesSet();
    const fromLower = tx.from.toLowerCase();
    if (!trackedSet.has(fromLower)) return;

    const txHash = tx.hash;
    if (dedupeStore.checkSourceTx(txHash)) {
      this.stats.duplicatesSkipped++;
      return;
    }

    const classification = classifyMintTransaction(
      tx.data || tx.input,
      tx.value ? tx.value.toString() : '0',
      tx.to,
      this.copyUnknownCalls
    );

    if (!classification.isMint) {
      this.stats.nonMintsRejected++;
      return;
    }

    dedupeStore.markSourceTx(txHash);
    this.stats.mintsDetected++;
    this.stats.lastDetectionTime = Date.now();

    const candidate = {
      sourceTxHash: txHash,
      sourceWallet: tx.from,
      label: trackedWalletService.getLabel(tx.from),
      targetContract: tx.to,
      calldata: tx.data || tx.input,
      value: tx.value ? tx.value.toString() : '0',
      gasPrice: tx.gasPrice ? tx.gasPrice.toString() : null,
      maxFeePerGas: tx.maxFeePerGas ? tx.maxFeePerGas.toString() : null,
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? tx.maxPriorityFeePerGas.toString() : null,
      gasLimit: tx.gasLimit ? tx.gasLimit.toString() : null,
      detectionSource: source,
      blockNumber,
      detectedAt: Date.now(),
      classification
    };

    logger.info(`[Tracker/${source === 'mempool' ? 'Pending' : 'Block'}] 🚀 Whale mint detected from ${candidate.label} (${candidate.sourceWallet.slice(0, 8)}...) -> ${candidate.targetContract.slice(0, 8)}...`);
    this.emit('mint_detected', candidate);
  }

  async _processPendingTx(txHash) {
    const trackedSet = trackedWalletService.getActiveAddressesSet();
    if (trackedSet.size === 0) return;

    try {
      const tx = await this.httpProvider.getTransaction(txHash);
      if (tx) {
        this._handleTransactionObject(tx, 'mempool');
      }
    } catch {
      // Pending tx dropped, safely ignore
    }
  }

  // ─── HTTP Block Polling Fallback ────────────────────────────────
  _startBlockPolling() {
    this._blockHandler = async (blockNumber) => {
      if (!this.isRunning || blockNumber <= this.lastProcessedBlock) return;
      this.lastProcessedBlock = blockNumber;
      this.stats.blocksSeen++;

      if (Date.now() < this.bootGraceUntil) return;

      await this._processBlock(blockNumber).catch(err => {
        logger.warn(`[Tracker/Block] Error processing block #${blockNumber}: ${err.message}`);
      });
    };

    this.httpProvider.on('block', this._blockHandler);
  }

  async _processBlock(blockNumber) {
    const trackedSet = trackedWalletService.getActiveAddressesSet();
    if (trackedSet.size === 0) return;

    try {
      const block = await this.httpProvider.getBlock(blockNumber, true);
      if (!block || !block.prefetchedTransactions) return;

      for (const tx of block.prefetchedTransactions) {
        if (!tx || !tx.from || !tx.to) continue;

        const fromLower = tx.from.toLowerCase();
        if (!trackedSet.has(fromLower)) continue;

        if (dedupeStore.checkSourceTx(tx.hash)) {
          this.stats.duplicatesSkipped++;
          continue;
        }

        const classification = classifyMintTransaction(
          tx.data,
          tx.value ? tx.value.toString() : '0',
          tx.to,
          this.copyUnknownCalls
        );

        if (!classification.isMint) {
          this.stats.nonMintsRejected++;
          continue;
        }

        dedupeStore.markSourceTx(tx.hash);
        this.stats.mintsDetected++;
        this.stats.lastDetectionTime = Date.now();

        const candidate = {
          sourceTxHash: tx.hash,
          sourceWallet: tx.from,
          label: trackedWalletService.getLabel(tx.from),
          targetContract: tx.to,
          calldata: tx.data,
          value: tx.value ? tx.value.toString() : '0',
          gasPrice: tx.gasPrice ? tx.gasPrice.toString() : null,
          maxFeePerGas: tx.maxFeePerGas ? tx.maxFeePerGas.toString() : null,
          maxPriorityFeePerGas: tx.maxPriorityFeePerGas ? tx.maxPriorityFeePerGas.toString() : null,
          gasLimit: tx.gasLimit ? tx.gasLimit.toString() : null,
          detectionSource: 'block',
          blockNumber,
          detectedAt: Date.now(),
          classification
        };

        logger.info(`[Tracker/Block] ✅ Confirmed whale mint from ${candidate.label} in block #${blockNumber}`);
        this.emit('mint_detected', candidate);
      }
    } catch (err) {
      // RPC transient error
    }
  }

  getStats() {
    return {
      ...this.stats,
      trackedWalletsCount: trackedWalletService.getActiveAddressesSet().size,
      isRunning: this.isRunning
    };
  }
}

module.exports = TrackerEngine;
