/**
 * Tracked Wallet Service — Persistent JSON registry for whale wallets.
 *
 * Stores tracked wallet addresses, custom labels, and active/inactive status in `data/tracked_wallets.json`.
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const logger = require('../utils/logger');

const DATA_DIR = path.join(process.cwd(), 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'tracked_wallets.json');

class TrackedWalletService {
  constructor() {
    this._ensureStorage();
    this.wallets = this._load();
  }

  _ensureStorage() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(STORAGE_FILE)) {
      fs.writeFileSync(STORAGE_FILE, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  _load() {
    try {
      this._ensureStorage();
      const content = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(content || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      logger.warn(`Could not load tracked_wallets.json: ${err.message}`);
      return [];
    }
  }

  _save() {
    try {
      this._ensureStorage();
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.wallets, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`Could not save tracked_wallets.json: ${err.message}`);
    }
  }

  /**
   * Get list of all tracked wallets.
   * @returns {Array<{address: string, label: string, active: boolean, addedAt: number}>}
   */
  getWallets() {
    return [...this.wallets];
  }

  /**
   * Get active tracked addresses (lowercased set for fast lookup)
   * @returns {Set<string>}
   */
  getActiveAddressesSet() {
    const set = new Set();
    for (const w of this.wallets) {
      if (w.active !== false && ethers.isAddress(w.address)) {
        set.add(w.address.toLowerCase());
      }
    }
    return set;
  }

  /**
   * Add a wallet to the tracking list.
   *
   * @param {string} address - EVM address
   * @param {string} [label] - Optional friendly label
   * @returns {object} Added wallet entry
   */
  addWallet(address, label = '') {
    if (!address || !ethers.isAddress(address)) {
      throw new Error(`Invalid EVM wallet address: ${address}`);
    }

    const checksummed = ethers.getAddress(address);
    const existingIndex = this.wallets.findIndex(
      w => w.address.toLowerCase() === checksummed.toLowerCase()
    );

    const entry = {
      address: checksummed,
      label: label.trim() || `Whale-${checksummed.slice(0, 6)}`,
      active: true,
      addedAt: Date.now()
    };

    if (existingIndex >= 0) {
      this.wallets[existingIndex] = { ...this.wallets[existingIndex], ...entry };
    } else {
      this.wallets.push(entry);
    }

    this._save();
    return entry;
  }

  /**
   * Remove a wallet from the tracking list.
   *
   * @param {string} address
   * @returns {boolean} True if removed
   */
  removeWallet(address) {
    if (!address) return false;
    const initialLen = this.wallets.length;
    this.wallets = this.wallets.filter(
      w => w.address.toLowerCase() !== address.toLowerCase()
    );

    if (this.wallets.length !== initialLen) {
      this._save();
      return true;
    }
    return false;
  }

  /**
   * Toggle active state of a wallet.
   *
   * @param {string} address
   * @returns {boolean} New active state
   */
  toggleActive(address) {
    const entry = this.wallets.find(
      w => w.address.toLowerCase() === address.toLowerCase()
    );
    if (!entry) throw new Error(`Wallet not found: ${address}`);
    entry.active = !entry.active;
    this._save();
    return entry.active;
  }

  /**
   * Check if address is actively tracked.
   */
  isTracked(address) {
    if (!address) return false;
    return this.getActiveAddressesSet().has(address.toLowerCase());
  }

  /**
   * Get label for an address.
   */
  getLabel(address) {
    if (!address) return 'Unknown';
    const entry = this.wallets.find(
      w => w.address.toLowerCase() === address.toLowerCase()
    );
    return entry?.label || address.slice(0, 8);
  }

  /**
   * Import wallets from Scout output array.
   *
   * @param {Array<{address: string, label?: string, profit?: string}>} scoutList
   * @returns {number} Number of imported wallets
   */
  importFromScout(scoutList = []) {
    let count = 0;
    for (const item of scoutList) {
      const addr = item.address || item;
      if (ethers.isAddress(addr)) {
        this.addWallet(addr, item.label || `Scout Whale (${item.profit || 'Top'})`);
        count++;
      }
    }
    return count;
  }
}

module.exports = new TrackedWalletService();
