const { ethers } = require('ethers');
const logger = require('../utils/logger');

/**
 * Arbitrum Nitro sequencer feed client.
 *
 * Robinhood Chain is a Nitro chain (`nitro/v3.11.3`, ArbOS 61) whose sequencer
 * orders transactions strictly first-come-first-served: `eth_maxPriorityFeePerGas`
 * is 0, Timeboost is not enabled (`arb_getRawBlockMetadata` returns null and the
 * `timeboost_*`/`auctioneer_*` methods are absent), so gas cannot buy queue
 * position. Arrival time at the sequencer is the only thing that decides a mint.
 *
 * That makes every HTTP round-trip expensive — measured 224-247ms from a home
 * connection while the node's own service time is 1ms. The feed removes the
 * round-trip entirely: it is a push stream of what the sequencer has *already*
 * ordered, so it answers two questions with zero latency.
 *
 *  - **Has the drop opened?** `sequencerTimestampSec()` is the sequencer's own
 *    clock. Polling `eth_getBlockByNumber` to learn the same thing costs a full
 *    round-trip, so the bot would find out ~120ms after the fact.
 *  - **Did my transaction land?** `watch(hash)` resolves the instant the
 *    sequencer orders it, replacing a 40ms polling loop that was issuing ~6
 *    overlapping requests per provider against a 240ms round-trip.
 *
 * The feed reports *ordering*, not execution: a transaction present here is
 * sequenced but may still revert, so callers that need success/failure still
 * fetch one receipt afterwards. That is one request instead of hundreds.
 *
 * Everything here is best-effort. If the socket never opens the caller keeps its
 * HTTP path, so a feed outage costs latency, never the snipe.
 *
 * Wire format (verified live 2026-08-31 against mainnet, 5/5 decoded hashes
 * confirmed by `eth_getTransactionByHash`):
 *
 *   { version: 1, messages: [ { sequenceNumber, message: { message: {
 *       header: { kind, sender, timestamp, ... }, l2Msg: <base64> } } } ] }
 *
 * `l2Msg` is a kind-tagged Nitro L2 message: kind 4 carries one raw signed
 * transaction, kind 3 is a batch of 8-byte-big-endian length-prefixed
 * sub-messages. On this chain `sequenceNumber` equals the L2 block number.
 */

/** Nitro L2 message kinds we decode. Others carry no user transactions. */
const L2_MESSAGE_KIND_BATCH = 3;
const L2_MESSAGE_KIND_SIGNED_TX = 4;

/** Guard against a malformed batch nesting far enough to blow the stack. */
const MAX_BATCH_DEPTH = 4;

/**
 * How stale the feed clock may be before callers stop trusting it. The feed only
 * advances when the chain sees traffic, so an idle chain leaves the timestamp
 * behind and the caller must fall back to an explicit block read.
 */
const CLOCK_STALE_MS = 2000;

/** Reconnect backoff, capped so a long outage keeps retrying cheaply. */
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 5000;

/**
 * Resolve a WebSocket implementation without adding a dependency.
 * Node 22+ ships a global `WebSocket`; older runtimes fall back to the `ws`
 * package already present via ethers.
 * @returns {Function|null}
 */
function resolveWebSocketImpl() {
  if (typeof globalThis.WebSocket === 'function') return globalThis.WebSocket;
  try {
    return require('ws');
  } catch (err) {
    return null;
  }
}

/**
 * Pull the raw signed transactions out of a Nitro `l2Msg` payload.
 * @param {Buffer} buf Decoded l2Msg bytes, still kind-tagged
 * @param {string[]} [out] Accumulator
 * @param {number} [depth]
 * @returns {string[]} Hex-encoded raw signed transactions
 */
function extractSignedTxs(buf, out = [], depth = 0) {
  if (depth > MAX_BATCH_DEPTH || !buf || buf.length < 1) return out;

  const kind = buf[0];
  const body = buf.subarray(1);

  if (kind === L2_MESSAGE_KIND_SIGNED_TX) {
    if (body.length) out.push('0x' + body.toString('hex'));
    return out;
  }

  if (kind === L2_MESSAGE_KIND_BATCH) {
    let offset = 0;
    // Each entry is [uint64 big-endian length][nested kind-tagged message]
    while (offset + 8 <= body.length) {
      const length = Number(body.readBigUInt64BE(offset));
      offset += 8;
      if (length <= 0 || offset + length > body.length) break;
      extractSignedTxs(body.subarray(offset, offset + length), out, depth + 1);
      offset += length;
    }
  }

  return out;
}

class SequencerFeed {
  /**
   * @param {string} feedUrl e.g. wss://feed.mainnet.chain.robinhood.com
   */
  constructor(feedUrl) {
    this.feedUrl = feedUrl;
    this.socket = null;
    this.isOpen = false;
    this.closedByUs = false;

    /** Sequencer clock, seconds, from the newest message seen. */
    this._sequencerTimestampSec = 0;
    /** When we observed that timestamp locally, for staleness checks. */
    this._clockObservedAtMs = 0;
    /** Newest sequence number (== L2 block number on this chain). */
    this.latestSequenceNumber = 0;

    /** txHash (lowercase) -> Set of waiters. A hash may be watched more than once. */
    this._watched = new Map();
    /** Hashes already seen, so a watch registered late still resolves. */
    this._seen = new Map();
    /** Subscribers for every decoded transaction (copy-mint, scouting). */
    this._txListeners = new Set();

    this._reconnectAttempt = 0;
    this._reconnectTimer = null;
    this.stats = { messages: 0, txs: 0, reconnects: 0 };
  }

  /**
   * Open the feed. Never throws — resolves false when the feed is unusable so
   * the caller can carry on with its HTTP path.
   * @param {number} [timeoutMs=4000]
   * @returns {Promise<boolean>}
   */
  async start(timeoutMs = 4000) {
    if (!this.feedUrl || !/^wss?:\/\//.test(this.feedUrl)) return false;

    const WebSocketImpl = resolveWebSocketImpl();
    if (!WebSocketImpl) {
      logger.warn('No WebSocket implementation available — sequencer feed disabled.');
      return false;
    }
    this._WebSocketImpl = WebSocketImpl;

    const opened = await this._connect(timeoutMs);
    if (opened) {
      logger.speed(`Sequencer feed live: ${this.feedUrl} (zero-round-trip drop clock + inclusion)`);
    }
    return opened;
  }

  /**
   * @param {number} timeoutMs
   * @returns {Promise<boolean>}
   */
  _connect(timeoutMs) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      let socket;
      try {
        socket = new this._WebSocketImpl(this.feedUrl);
      } catch (err) {
        return settle(false);
      }
      this.socket = socket;

      const timer = setTimeout(() => {
        // Handshake never completed; drop it rather than leaving a socket that
        // silently connects later and confuses the caller's fallback decision.
        try { socket.close(); } catch (e) {}
        settle(false);
      }, timeoutMs);

      const onOpen = () => {
        this.isOpen = true;
        this._reconnectAttempt = 0;
        clearTimeout(timer);
        settle(true);
      };

      const onMessage = (event) => {
        // Native WebSocket delivers { data }, `ws` delivers the payload directly.
        const payload = event && event.data !== undefined ? event.data : event;
        this._ingest(payload);
      };

      const onClose = () => {
        this.isOpen = false;
        clearTimeout(timer);
        settle(false);
        this._scheduleReconnect();
      };

      const onError = () => {
        this.isOpen = false;
        clearTimeout(timer);
        settle(false);
      };

      // Native WebSocket uses addEventListener; `ws` is an EventEmitter.
      if (typeof socket.addEventListener === 'function') {
        socket.addEventListener('open', onOpen);
        socket.addEventListener('message', onMessage);
        socket.addEventListener('close', onClose);
        socket.addEventListener('error', onError);
      } else {
        socket.on('open', onOpen);
        socket.on('message', onMessage);
        socket.on('close', onClose);
        socket.on('error', onError);
      }
    });
  }

  /** Reconnect with capped backoff unless we closed on purpose. */
  _scheduleReconnect() {
    if (this.closedByUs || this._reconnectTimer) return;

    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempt));
    this._reconnectAttempt += 1;
    this.stats.reconnects += 1;

    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (this.closedByUs) return;
      await this._connect(4000);
    }, delay);
    if (this._reconnectTimer.unref) this._reconnectTimer.unref();
  }

  /**
   * Decode one feed frame: advance the clock, then resolve any watched hashes.
   * @param {string|Buffer} payload
   */
  _ingest(payload) {
    let frame;
    try {
      frame = JSON.parse(typeof payload === 'string' ? payload : Buffer.from(payload).toString('utf-8'));
    } catch (err) {
      return;
    }

    const messages = Array.isArray(frame.messages) ? frame.messages : [];
    if (!messages.length) return;
    this.stats.messages += messages.length;

    for (const entry of messages) {
      const inner = entry && entry.message && entry.message.message;
      if (!inner) continue;

      const sequenceNumber = Number(entry.sequenceNumber) || 0;
      if (sequenceNumber > this.latestSequenceNumber) {
        this.latestSequenceNumber = sequenceNumber;
      }

      const timestampSec = Number(inner.header && inner.header.timestamp) || 0;
      if (timestampSec > this._sequencerTimestampSec) {
        this._sequencerTimestampSec = timestampSec;
        this._clockObservedAtMs = Date.now();
      }

      if (!inner.l2Msg) continue;

      let rawTxs;
      try {
        rawTxs = extractSignedTxs(Buffer.from(inner.l2Msg, 'base64'));
      } catch (err) {
        continue;
      }

      for (const raw of rawTxs) {
        this.stats.txs += 1;
        let hash;
        try {
          hash = ethers.keccak256(raw).toLowerCase();
        } catch (err) {
          continue;
        }

        const record = { hash, raw, sequenceNumber, timestampSec, observedAtMs: Date.now() };
        this._recordSeen(hash, record);

        const waiters = this._watched.get(hash);
        if (waiters) {
          this._watched.delete(hash);
          for (const waiter of waiters) {
            try { waiter.resolve(record); } catch (err) { /* one bad waiter can't stall the rest */ }
          }
        }

        if (this._txListeners.size) {
          for (const listener of this._txListeners) {
            try { listener(record); } catch (err) { /* a bad subscriber can't break the feed */ }
          }
        }
      }
    }
  }

  /**
   * Remember a hash so a watch registered slightly late still resolves.
   * Bounded, because a busy chain would otherwise grow this without limit.
   * @param {string} hash
   * @param {object} record
   */
  _recordSeen(hash, record) {
    this._seen.set(hash, record);
    if (this._seen.size > 4096) {
      // Map preserves insertion order, so this evicts oldest-first.
      const oldest = this._seen.keys().next();
      if (!oldest.done) this._seen.delete(oldest.value);
    }
  }

  /**
   * The sequencer's own clock in seconds, or 0 when the feed is not live or the
   * clock has gone stale. Callers must treat 0 as "ask the RPC instead".
   * @returns {number}
   */
  sequencerTimestampSec() {
    if (!this.isOpen || !this._sequencerTimestampSec) return 0;
    if (Date.now() - this._clockObservedAtMs > CLOCK_STALE_MS) return 0;
    return this._sequencerTimestampSec;
  }

  /**
   * Has the sequencer's clock reached `startTimeSec`?
   * Returns false when the feed can't answer, so the caller keeps its fallback.
   * @param {number} startTimeSec
   * @returns {boolean}
   */
  hasReachedTimestamp(startTimeSec) {
    const clock = this.sequencerTimestampSec();
    return clock > 0 && startTimeSec > 0 && clock >= startTimeSec;
  }

  /**
   * Resolve when the sequencer orders `txHash`.
   *
   * Register this *before* broadcasting: transactions are pre-signed, so the
   * hash is known well ahead of the drop, and a feed frame can arrive before a
   * post-broadcast registration would have been in place.
   *
   * @param {string} txHash
   * @param {number} [timeoutMs=60000]
   * @returns {Promise<{hash: string, sequenceNumber: number, timestampSec: number}|null>}
   *   null on timeout or when the feed isn't live.
   */
  watch(txHash, timeoutMs = 60000) {
    if (!txHash) return Promise.resolve(null);
    const hash = String(txHash).toLowerCase();

    const already = this._seen.get(hash);
    if (already) return Promise.resolve(already);
    if (!this.isOpen) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter = {
        resolve: (record) => {
          clearTimeout(waiter.timer);
          resolve(record);
        }
      };

      waiter.timer = setTimeout(() => {
        // Drop only this waiter; another caller may still be watching the hash.
        const waiters = this._watched.get(hash);
        if (waiters) {
          waiters.delete(waiter);
          if (!waiters.size) this._watched.delete(hash);
        }
        resolve(null);
      }, timeoutMs);
      if (waiter.timer.unref) waiter.timer.unref();

      let waiters = this._watched.get(hash);
      if (!waiters) {
        waiters = new Set();
        this._watched.set(hash, waiters);
      }
      waiters.add(waiter);
    });
  }

  /**
   * Subscribe to every decoded transaction. Used by whale mirroring; the
   * callback must not throw.
   * @param {(record: {hash: string, raw: string, sequenceNumber: number}) => void} listener
   * @returns {() => void} Unsubscribe
   */
  onTransaction(listener) {
    if (typeof listener !== 'function') return () => {};
    this._txListeners.add(listener);
    return () => this._txListeners.delete(listener);
  }

  /** Close the socket and stop reconnecting. */
  close() {
    this.closedByUs = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    for (const [, waiters] of this._watched) {
      for (const waiter of waiters) {
        try { waiter.resolve(null); } catch (e) {}
      }
    }
    this._watched.clear();
    this.isOpen = false;
    try {
      if (this.socket) this.socket.close();
    } catch (err) {
      try { this.socket.terminate(); } catch (e) {}
    }
    this.socket = null;
  }
}

module.exports = { SequencerFeed, extractSignedTxs };
