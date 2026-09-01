const { ethers } = require('ethers');
const logger = require('../utils/logger');
const connectionManager = require('../services/connectionManager');

/**
 * Multi-endpoint broadcast engine.
 *
 * v3.2 — FIFO-aware. Robinhood Chain is an Arbitrum Nitro chain whose sequencer
 * orders transactions strictly first-come-first-served (priority fee is 0
 * chain-wide, Timeboost is off), so this class is built around one fact:
 *
 *   Only the sequencer can order a transaction. Every other endpoint is a
 *   replica that forwards to it, so extra hops are latency, not redundancy.
 *
 * Two consequences shape the code:
 *
 *  - Endpoints carry a `broadcastOnly` flag. The sequencer's write ingress
 *    serves `eth_sendRawTransaction` and rejects every read method, so it gets
 *    no ethers provider and is excluded from receipt polling — but it is the
 *    first thing we send to.
 *  - Receipts come from the sequencer feed when available. Polling cost more
 *    than it bought: the old 40ms interval ran against a ~240ms round-trip, so
 *    each provider held roughly six requests in flight continuously for up to a
 *    minute, which is the fastest way to get rate-limited mid-snipe.
 */

/**
 * Micro-burst offsets in ms.
 *
 * Duplicate sends of the same signed transaction are idempotent — the sequencer
 * takes the first and answers "already known" for the rest — so pulses are pure
 * packet-loss insurance and cannot improve queue position. Under FIFO the race
 * is decided by the first arrival, and at ~11 blocks/second on this chain a
 * pulse at 380ms lands several blocks after the outcome is settled. The old
 * `[0, 45, 110, 220, 380]` tail therefore spent rate limit for nothing; three
 * tight pulses keep the insurance and drop the dead weight.
 */
const DEFAULT_BURST_OFFSETS = [0, 40, 90];

/**
 * Receipt poll interval. Sized to the real round-trip (measured 224-247ms on
 * this chain) rather than the old 40ms, which merely stacked overlapping
 * requests. Used only when the feed cannot tell us about inclusion.
 */
const DEFAULT_RECEIPT_POLL_MS = 250;

/** Once the feed says a transaction is sequenced, its receipt exists — fetch hard. */
const CONFIRMED_POLL_MS = 60;

function parseIntEnv(name, fallback) {
  const parsed = parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Flatten an AggregateError from Promise.any into one readable line.
 * Without this, a total broadcast failure surfaces as "All promises were
 * rejected", which hides the RPC's actual complaint.
 * @param {any} err
 * @param {string} fallbackMsg
 * @returns {Error}
 */
function flattenAggregate(err, fallbackMsg) {
  const errors = err && Array.isArray(err.errors) ? err.errors : (err ? [err] : []);
  const seen = [];
  for (const e of errors) {
    const msg = (e && e.message ? e.message : String(e)).trim();
    // Recurse: each pulse's own Promise.any produces a nested AggregateError.
    if (e && Array.isArray(e.errors)) {
      const inner = flattenAggregate(e, '').message;
      if (inner && !seen.includes(inner)) seen.push(inner);
    } else if (msg && !seen.includes(msg)) {
      seen.push(msg);
    }
  }
  const detail = seen.slice(0, 4).join(' | ');
  const out = new Error(detail || fallbackMsg || 'Broadcast failed on every endpoint');
  out.causes = errors;
  return out;
}

class MultiRpcBroadcaster {
  /**
   * @param {Array<string|{url: string, broadcastOnly?: boolean, label?: string}>} endpoints
   * @param {number} chainId
   * @param {{feed?: import('../services/sequencerFeed').SequencerFeed}} [options]
   */
  constructor(endpoints, chainId, options = {}) {
    this.chainId = chainId;
    this.feed = options.feed || null;

    // Accept plain URL strings (legacy callers) or tagged descriptors.
    const seen = new Set();
    this.endpoints = [];
    for (const entry of endpoints || []) {
      const url = typeof entry === 'string' ? entry : (entry && entry.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const broadcastOnly = typeof entry === 'object' && entry ? !!entry.broadcastOnly : false;
      this.endpoints.push({
        url,
        broadcastOnly,
        label: (typeof entry === 'object' && entry && entry.label) || url,
        // A broadcast-only ingress answers no read method, so building a
        // provider for it would only create something that fails on first use.
        provider: broadcastOnly ? null : connectionManager.createEthersProvider(url, chainId)
      });
    }

    // Every URL, including the sequencer — the socket pool must warm all of them.
    this.rpcUrls = this.endpoints.map(e => e.url);
    // Read-capable subset, for receipts and any state query.
    this.readEndpoints = this.endpoints.filter(e => !e.broadcastOnly);
    this.readUrls = this.readEndpoints.map(e => e.url);
    this.providers = this.readEndpoints.map(e => e.provider);

    this.burstOffsets = MultiRpcBroadcaster.resolveBurstOffsets();

    // Push-based WebSocket receipt channel. Resolved in the background so the
    // constructor stays synchronous, and only ever set to a socket that has been
    // verified OPEN — a handshake still in flight would swallow a broadcast whole.
    this.wsProvider = null;
    this.wsUrl = null;
    this.wsReady = this._initWsChannel();
  }

  /**
   * Burst offsets, overridable via SNIPER_BURST_OFFSETS="0,40,90".
   * @returns {number[]}
   */
  static resolveBurstOffsets() {
    const raw = (process.env.SNIPER_BURST_OFFSETS || '').trim();
    if (!raw) return DEFAULT_BURST_OFFSETS;
    const parsed = raw.split(',')
      .map(part => parseInt(part.trim(), 10))
      .filter(n => Number.isFinite(n) && n >= 0);
    return parsed.length ? parsed : DEFAULT_BURST_OFFSETS;
  }

  /**
   * Locate and verify a live WebSocket endpoint for this chain (never throws).
   * Only read endpoints are considered — the sequencer ingress is HTTP-only.
   * @returns {Promise<import('ethers').WebSocketProvider|null>}
   */
  async _initWsChannel() {
    // The Nitro feed already gives push-based inclusion, so a JSON-RPC
    // WebSocket adds nothing and its handshake would just cost warmup time.
    if (this.feed && this.feed.isOpen) return null;

    try {
      const live = await connectionManager.resolveLiveWsProvider(this.readUrls, this.chainId);
      if (live) {
        this.wsProvider = live.provider;
        this.wsUrl = live.url;
        logger.speed(`WebSocket push channel live: ${MultiRpcBroadcaster.maskUrl(live.url)}`);
        return live.provider;
      }
    } catch (err) {
      // No WebSocket available — HTTP polling covers every path below
    }
    return null;
  }

  /**
   * Strip API keys out of an endpoint URL before logging it
   * @param {string} url
   * @returns {string}
   */
  static maskUrl(url) {
    return String(url || '').replace(/\/(ws\/v3|v3|v2)\/[^/?#]+/, '/$1/***');
  }

  /**
   * Detect RPC error messages that actually indicate successful mempool propagation
   * @param {string} msg
   */
  static isBenignDuplicateError(msg) {
    if (!msg) return false;
    const benignPatterns = [
      /already known/i,
      /known transaction/i,
      /transaction already in mempool/i,
      /nonce too low/i,
      /already imported/i,
      /replacement transaction underpriced/i,
      /tx already exists/i
    ];
    return benignPatterns.some(p => p.test(msg));
  }

  /**
   * Concurrently broadcast a raw signed transaction across all configured endpoints.
   * The sequencer ingress is included and is normally the winner — it is the only
   * endpoint that does not have to forward the transaction onward.
   *
   * @param {string} signedTx Pre-signed raw transaction bytes (0x...)
   * @param {Buffer} [rawBuffer] Pre-serialized JSON-RPC Buffer (zero-allocation)
   * @returns {Promise<{ txHash: string, fastestRpc: string, durationMs: number }>}
   * @throws {Error} When every endpoint rejected — carries the real RPC messages
   */
  async broadcastFastest(signedTx, rawBuffer = null) {
    const startTime = Date.now();
    const computedTxHash = ethers.keccak256(signedTx);
    const buf = rawBuffer || connectionManager.createRawBufferPayload(signedTx);

    const broadcastPromises = this.endpoints.map(async (endpoint) => {
      try {
        // Fast path: direct raw Buffer over a persistent TCP_NODELAY socket
        let txHash;
        try {
          txHash = await connectionManager.sendRawTransactionBuffer(endpoint.url, buf, 6000);
        } catch (rawErr) {
          if (MultiRpcBroadcaster.isBenignDuplicateError(rawErr.message)) {
            return { url: endpoint.label, txHash: computedTxHash, status: 'ALREADY_PROPAGATED' };
          }
          // Fallback path: ethers provider. Unavailable on a broadcast-only
          // ingress, where the raw path is already the only path.
          if (!endpoint.provider) throw rawErr;
          const txResponse = await endpoint.provider.broadcastTransaction(signedTx);
          txHash = txResponse.hash;
        }

        return { url: endpoint.label, txHash: txHash || computedTxHash, status: 'ACCEPTED' };
      } catch (err) {
        if (MultiRpcBroadcaster.isBenignDuplicateError(err.message)) {
          return { url: endpoint.label, txHash: computedTxHash, status: 'ALREADY_PROPAGATED' };
        }
        throw new Error(`[${endpoint.label}] ${err.message}`);
      }
    });

    // Also race the JSON-RPC WebSocket when one is live
    if (this.wsProvider) {
      broadcastPromises.push((async () => {
        try {
          const res = await this.wsProvider.send('eth_sendRawTransaction', [signedTx]);
          return { url: 'websocket', txHash: res || computedTxHash, status: 'ACCEPTED' };
        } catch (wsErr) {
          if (MultiRpcBroadcaster.isBenignDuplicateError(wsErr.message)) {
            return { url: 'websocket', txHash: computedTxHash, status: 'ALREADY_PROPAGATED' };
          }
          throw wsErr;
        }
      })());
    }

    if (!broadcastPromises.length) {
      throw new Error('No broadcast endpoints configured');
    }

    let fastestResult;
    try {
      fastestResult = await Promise.any(broadcastPromises);
    } catch (aggregate) {
      throw flattenAggregate(aggregate, 'Every endpoint rejected the transaction');
    }

    return {
      txHash: fastestResult.txHash || computedTxHash,
      fastestRpc: fastestResult.url,
      durationMs: Date.now() - startTime
    };
  }

  /**
   * Micro-burst broadcast: the same pre-signed transaction sent in a few tight
   * pulses as packet-loss insurance. The nonce is fixed, so duplicates are
   * idempotent and cost no gas.
   *
   * Unlike v3.1 this **propagates failure**. Previously each pulse caught its own
   * error and resolved with a locally computed hash, so a transaction no endpoint
   * had accepted looked like a success: the caller then waited the full receipt
   * timeout for something that did not exist, and the RPC's real complaint
   * (rate limit, underpriced, insufficient funds) was discarded. On a chain where
   * the race is over in milliseconds, that silent stall is the whole drop.
   *
   * @param {string} signedTx
   * @param {Buffer} [rawBuffer]
   * @param {number[]} [burstOffsets] Millisecond offsets; defaults to SNIPER_BURST_OFFSETS
   * @returns {Promise<{ txHash: string, fastestRpc: string, durationMs: number }>}
   * @throws {Error} When every pulse failed on every endpoint
   */
  async broadcastFlood(signedTx, rawBuffer = null, burstOffsets = null) {
    const startTime = Date.now();
    const offsets = burstOffsets && burstOffsets.length ? burstOffsets : this.burstOffsets;
    const buf = rawBuffer || connectionManager.createRawBufferPayload(signedTx);

    // Once any pulse lands, later pulses are pointless: the sequencer has the
    // transaction and would only answer "already known" while spending rate limit.
    let landed = false;

    const pulses = offsets.map(async (offset) => {
      if (offset > 0) {
        await new Promise(r => setTimeout(r, offset));
        if (landed) {
          // Not a failure, but nothing to report — stay pending so Promise.any
          // still settles on a real result or a real aggregate error.
          return new Promise(() => {});
        }
      }
      const result = await this.broadcastFastest(signedTx, buf);
      landed = true;
      return result;
    });

    // Promise.any only consumes the first rejection it needs; attaching a second
    // handler keeps Node from flagging the losers as unhandled rejections.
    for (const p of pulses) p.catch(() => {});

    try {
      const fastestResult = await Promise.any(pulses);
      return {
        txHash: fastestResult.txHash,
        fastestRpc: fastestResult.fastestRpc,
        durationMs: Date.now() - startTime
      };
    } catch (aggregate) {
      throw flattenAggregate(aggregate, 'Broadcast failed on every endpoint and every pulse');
    }
  }

  /**
   * Wait for a transaction to be included, then return its receipt.
   *
   * Prefers the sequencer feed: it pushes what the sequencer has already ordered,
   * so inclusion arrives with no round-trip at all, and only then do we spend a
   * single request on the receipt (the feed proves ordering, not success — a
   * sequenced transaction can still revert). Falls back to a WebSocket provider,
   * then to HTTP polling paced to the real round-trip.
   *
   * @param {string} txHash
   * @param {number} [confirmations=1]
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<{ receipt: ethers.TransactionReceipt, fastProvider: string }>}
   */
  async waitForReceiptFastest(txHash, confirmations = 1, timeoutMs = 60000) {
    const deadline = Date.now() + timeoutMs;
    const basePollMs = parseIntEnv('SNIPER_RECEIPT_POLL_MS', DEFAULT_RECEIPT_POLL_MS);

    return new Promise((resolve, reject) => {
      let resolved = false;
      let pollMs = basePollMs;
      let timeoutTimer = null;

      const settle = (receipt, fastProvider) => {
        if (resolved) return;
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve({ receipt, fastProvider });
      };

      // Strategy 1: sequencer feed — zero round-trip inclusion signal.
      if (this.feed && this.feed.isOpen) {
        this.feed.watch(txHash, timeoutMs)
          .then(record => {
            if (!record || resolved) return;
            // Ordered. The receipt is now guaranteed to exist, so stop pacing
            // for a chain that might not have seen the transaction yet.
            pollMs = CONFIRMED_POLL_MS;
            logger.speed(
              `Feed confirmed sequencing at #${record.sequenceNumber} — fetching receipt`
            );
          })
          .catch(() => {});
      }

      // Strategy 2: JSON-RPC WebSocket push, when one is live.
      if (this.wsProvider) {
        this.wsProvider.waitForTransaction(txHash, confirmations, timeoutMs)
          .then(receipt => { if (receipt) settle(receipt, 'websocket'); })
          .catch(() => {}); // WS errors are non-fatal; polling continues
      }

      // Strategy 3: HTTP polling across read endpoints, paced to the measured
      // round-trip. The old 40ms interval simply stacked overlapping requests.
      const checkReceipt = async (provider, url) => {
        while (!resolved && Date.now() < deadline) {
          try {
            const receipt = await provider.getTransactionReceipt(txHash);
            if (receipt && receipt.blockNumber) {
              const confirms = await receipt.confirmations();
              if (confirms >= confirmations) {
                settle(receipt, url);
                return;
              }
            }
          } catch (e) {
            // Ignore polling errors on individual endpoints
          }
          if (resolved) return;
          await new Promise(r => setTimeout(r, pollMs));
        }
      };

      if (!this.providers.length && !this.wsProvider && !(this.feed && this.feed.isOpen)) {
        reject(new Error('No read-capable endpoint available to confirm the transaction'));
        return;
      }

      this.readEndpoints.forEach(e => checkReceipt(e.provider, e.label));

      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error(`Transaction confirmation timeout after ${timeoutMs / 1000}s for ${txHash}`));
        }
      }, timeoutMs);
    });
  }
}

module.exports = MultiRpcBroadcaster;
module.exports.DEFAULT_BURST_OFFSETS = DEFAULT_BURST_OFFSETS;
module.exports.flattenAggregate = flattenAggregate;
