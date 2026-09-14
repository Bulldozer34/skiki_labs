const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

/**
 * Armed snipe persistence.
 *
 * Scheduled drops live in `state.activeSnipes` — a plain `Map` in heap memory.
 * If the process exits for any reason (crash, OOM, SIGKILL, Windows update,
 * Render cold restart), every armed drop vanishes without trace and the operator
 * has no way to know it happened until the drop opens and nothing fires.
 *
 * This module solves that by writing the armed configuration to disk the instant
 * the snipe is confirmed, and deleting it when the snipe completes or is
 * cancelled. On daemon startup, any persisted entries are re-armed automatically
 * so the bot picks up exactly where it left off.
 *
 * The file is intentionally plain JSON, not a database — one atomic
 * `writeFileSync` per arm/disarm is fast enough and survives partial writes
 * (the worst case is a truncated file, which the loader handles gracefully).
 */

const PERSISTENCE_DIR = path.join(process.cwd(), 'data');
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, 'armed_snipes.json');

/**
 * Ensure the data directory exists.
 */
function ensureDir() {
  try {
    if (!fs.existsSync(PERSISTENCE_DIR)) {
      fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
    }
  } catch (err) {
    // Non-fatal — the save will fail and log a warning
  }
}

/**
 * Save the current armed snipes map to disk.
 * Only serializes the configuration needed to re-arm — never private keys.
 *
 * @param {Map} activeSnipes The daemon's live activeSnipes map
 */
function save(activeSnipes) {
  ensureDir();
  try {
    const entries = [];
    for (const [id, drop] of activeSnipes.entries()) {
      // Only persist the re-armable configuration, never wallet private keys
      entries.push({
        id,
        target: drop.target,
        contractAddress: drop.contractAddress,
        collectionName: drop.collectionName,
        collectionSlug: drop.collectionSlug,
        chainKey: drop.chainKey,
        mode: drop.mode,
        quantity: drop.quantity,
        startTime: drop.startTime,
        walletsCount: drop.walletsCount,
        selectedWalletAddresses: drop.selectedWalletAddresses || (drop.selectedWallets ? drop.selectedWallets.map(w => w.address) : null),
        postMintLabel: drop.postMintLabel,
        postMintConfig: drop.postMintConfig,
        recipientAddress: drop.recipientAddress,
        walletSelectionLabel: drop.walletSelectionLabel,
        createdAt: drop.createdAt || Date.now(),
        persistedAt: Date.now()
      });
    }
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[Persistence] Could not save armed snipes to disk: ${err.message}`);
  }
}

/**
 * Load persisted armed snipes from disk.
 * Returns an array of drop configs that can be re-armed.
 * Handles corrupt/missing files gracefully — returns [] on any error.
 *
 * @returns {Array<object>} Array of persisted drop configurations
 */
function load() {
  try {
    if (!fs.existsSync(PERSISTENCE_FILE)) return [];
    const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8').trim();
    if (!raw || raw === '[]') return [];
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return [];

    // Filter out drops whose start time has already passed by more than 5 minutes
    // (they would have already fired or are stale)
    const nowSec = Math.floor(Date.now() / 1000);
    const valid = entries.filter(e => {
      if (!e || !e.target) return false;
      // Immediate or auto-sync drops are always valid to re-arm
      if (!e.startTime || e.startTime <= 1) return true;
      // Scheduled drops: allow re-arm if within 5 minutes past start time
      // (the engine handles "already live" detection)
      return e.startTime > (nowSec - 300);
    });

    return valid;
  } catch (err) {
    logger.warn(`[Persistence] Could not load armed snipes from disk: ${err.message}`);
    return [];
  }
}

/**
 * Remove a single drop from persistence by ID.
 * @param {string} dropId
 */
function remove(dropId) {
  try {
    if (!fs.existsSync(PERSISTENCE_FILE)) return;
    const raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8').trim();
    if (!raw) return;
    const entries = JSON.parse(raw);
    if (!Array.isArray(entries)) return;
    const filtered = entries.filter(e => e.id !== dropId);
    fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
  } catch (err) {
    logger.warn(`[Persistence] Could not remove drop ${dropId} from disk: ${err.message}`);
  }
}

/**
 * Clear all persisted snipes (e.g. after successful re-arm on boot).
 */
function clear() {
  try {
    if (fs.existsSync(PERSISTENCE_FILE)) {
      fs.writeFileSync(PERSISTENCE_FILE, '[]', 'utf-8');
    }
  } catch (err) {
    // Non-fatal
  }
}

module.exports = { save, load, remove, clear };
