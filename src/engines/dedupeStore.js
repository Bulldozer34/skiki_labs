/**
 * DedupeStore — In-memory TTL cache preventing duplicate mint executions.
 *
 * Tracks:
 * 1. Source transaction hashes (e.g. mempool pending vs confirmed block).
 * 2. Contract + calldata + value combinations.
 */

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

class DedupeStore {
  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
    this.store = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }
  }

  static contractKey(to, data, value = '0') {
    const toLower = (to || '').toLowerCase();
    const dataLower = (data || '').toLowerCase();
    const val = String(value || '0');
    return `contract:${toLower}:${dataLower}:${val}`;
  }

  static sourceTxKey(hash, scopeId) {
    const h = (hash || '').toLowerCase();
    return scopeId ? `tx:${scopeId}:${h}` : `tx:${h}`;
  }

  isDuplicate(key) {
    this._prune();
    const entry = this.store.get(key);
    return !!entry && entry.expiresAt > Date.now();
  }

  markSeen(key, reason = 'seen', executionId = null) {
    const now = Date.now();
    this.store.set(key, {
      key,
      reason,
      firstSeenAt: now,
      expiresAt: now + this.ttlMs,
      executionId
    });
  }

  checkSourceTx(hash, scopeId) {
    if (!hash) return false;
    return this.isDuplicate(DedupeStore.sourceTxKey(hash, scopeId));
  }

  markSourceTx(hash, executionId = null, scopeId = null) {
    if (!hash) return;
    this.markSeen(DedupeStore.sourceTxKey(hash, scopeId), 'source_tx', executionId);
  }

  checkContractExecution(to, data, value = '0') {
    return this.isDuplicate(DedupeStore.contractKey(to, data, value));
  }

  markExecuted(executionId, to, data, value = '0') {
    this.markSeen(DedupeStore.contractKey(to, data, value), 'executed', executionId);
  }

  size() {
    this._prune();
    return this.store.size;
  }

  clear() {
    this.store.clear();
  }
}

// Export singleton instance + class
const defaultDedupeStore = new DedupeStore();
defaultDedupeStore.DedupeStore = DedupeStore;

module.exports = defaultDedupeStore;
