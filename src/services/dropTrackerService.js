/**
 * Drop Tracker Service — Monitors OpenSea drops and alerts on phase transitions (Allowlist -> Public).
 */

const fs = require('fs');
const path = require('path');
const CollectionService = require('./collectionService');
const logger = require('../utils/logger');

const STORAGE_FILE = path.join(process.cwd(), 'data', 'tracked_mints.json');

class DropTrackerService {
  constructor() {
    this._ensureStorage();
    this.trackedDrops = this._load();
    this.pollInterval = null;
    this.client = null;
    this.chatId = null;
  }

  _ensureStorage() {
    const dir = path.dirname(STORAGE_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(STORAGE_FILE)) {
      fs.writeFileSync(STORAGE_FILE, '[]\n', 'utf-8');
    }
  }

  _load() {
    try {
      this._ensureStorage();
      const content = fs.readFileSync(STORAGE_FILE, 'utf-8');
      const parsed = JSON.parse(content || '[]');
      const list = Array.isArray(parsed) ? parsed : [];
      const nowSec = Math.floor(Date.now() / 1000);
      // Automatically discard drops that started more than 12 hours ago
      return list.filter(d => {
        if (!d.publicStartTime) return true;
        return (nowSec - d.publicStartTime) < 43200;
      });
    } catch (err) {
      logger.warn(`[DropTracker] Could not load tracked_mints.json: ${err.message}`);
      return [];
    }
  }

  _save() {
    try {
      this._ensureStorage();
      fs.writeFileSync(STORAGE_FILE, JSON.stringify(this.trackedDrops, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[DropTracker] Could not save tracked_mints.json: ${err.message}`);
    }
  }

  /**
   * Extract collection slug from an OpenSea URL or raw string
   * @param {string} input 
   * @returns {string} slug
   */
  extractSlug(input) {
    if (!input || typeof input !== 'string') return '';
    const trimmed = input.trim();
    // Match https://opensea.io/collection/<slug> or /collection/<slug>/drop
    const match = trimmed.match(/opensea\.io\/collection\/([a-zA-Z0-9\-_]+)/i);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
    // Clean trailing slashes or URL components
    return trimmed.split('/')[0].toLowerCase();
  }

  /**
   * Track a new drop via OpenSea URL or slug
   * @param {string} urlOrSlug 
   * @returns {Promise<object>} Tracked drop record
   */
  async trackDrop(urlOrSlug) {
    const slug = this.extractSlug(urlOrSlug);
    if (!slug) {
      throw new Error('Invalid OpenSea URL or collection slug.');
    }

    const dropInfo = await CollectionService.getDropInfo(slug, {});
    if (!dropInfo) {
      throw new Error(`Could not fetch drop data from OpenSea for slug: "${slug}". Ensure it is a valid OpenSea drop.`);
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const stages = dropInfo.stages || [];

    const parseTimeSec = (val) => {
      if (!val) return null;
      if (typeof val === 'number') {
        return val > 1e11 ? Math.floor(val / 1000) : val;
      }
      const num = Number(val);
      if (!isNaN(num) && num > 0) {
        return num > 1e11 ? Math.floor(num / 1000) : num;
      }
      const dt = new Date(val).getTime();
      return !isNaN(dt) && dt > 0 ? Math.floor(dt / 1000) : null;
    };

    // Identify Public Stage
    const publicStage = stages.find(s => (s.name || '').toLowerCase().includes('public')) || stages[stages.length - 1] || null;
    const publicStartTime = parseTimeSec(publicStage?.startTime);
    const publicPrice = publicStage?.mintPrice ? `${publicStage.mintPrice.unit || '0'} ${publicStage.mintPrice.symbol || 'ETH'}` : 'Free / 0 ETH';

    // Current active stage
    const currentStage = stages.find(s => {
      const st = parseTimeSec(s.startTime);
      const et = parseTimeSec(s.endTime);
      return st && nowSec >= st && (!et || et === 0 || nowSec < et);
    }) || null;

    const existingIdx = this.trackedDrops.findIndex(d => d.slug === slug);
    const record = {
      slug,
      name: dropInfo.name || slug,
      contractAddress: dropInfo.nftContractAddress || '',
      chain: dropInfo.chainIdentifier || 'ROBINHOOD',
      imageUrl: dropInfo.imageUrl || '',
      stagesCount: stages.length,
      currentStageName: currentStage ? currentStage.name : 'Upcoming / Not Started',
      publicStageName: publicStage ? publicStage.name : 'Public',
      publicStartTime,
      publicPrice,
      addedAt: Date.now(),
      alerted15m: publicStartTime ? (publicStartTime - nowSec <= 900) : false,
      alerted5m: publicStartTime ? (publicStartTime - nowSec <= 300) : false,
      alertedLive: publicStartTime ? (nowSec >= publicStartTime) : false
    };

    if (existingIdx >= 0) {
      this.trackedDrops[existingIdx] = record;
    } else {
      this.trackedDrops.push(record);
    }

    this._save();
    logger.info(`[DropTracker] Tracking drop: "${record.name}" (${slug})`);
    return record;
  }

  /**
   * Stop tracking a drop
   * @param {string} urlOrSlug 
   * @returns {boolean}
   */
  untrackDrop(urlOrSlug) {
    const slug = this.extractSlug(urlOrSlug);
    const initialLen = this.trackedDrops.length;
    this.trackedDrops = this.trackedDrops.filter(d => d.slug !== slug);
    const removed = this.trackedDrops.length !== initialLen;
    if (removed) this._save();
    return removed;
  }

  /**
   * Get all actively tracked drops
   */
  getTrackedDrops() {
    return [...this.trackedDrops];
  }

  /**
   * Start background polling for phase transitions
   * @param {object} client TelegramClient
   * @param {string|number} targetChatId
   */
  start(client, targetChatId) {
    this.client = client;
    this.chatId = targetChatId;

    if (this.pollInterval) return;

    logger.info('[DropTracker] Background drop phase watcher started (polling every 30s)');
    this.pollInterval = setInterval(() => {
      this._pollDrops().catch(err => {
        logger.warn(`[DropTracker] Poll error: ${err.message}`);
      });
    }, 30000);
  }

  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  async _pollDrops() {
    if (!this.client || !this.chatId || this.trackedDrops.length === 0) return;

    const nowSec = Math.floor(Date.now() / 1000);

    for (const drop of this.trackedDrops) {
      if (!drop.publicStartTime) continue;

      const diffSec = drop.publicStartTime - nowSec;

      // 1. T-15 minutes Alert
      if (diffSec <= 900 && diffSec > 300 && !drop.alerted15m) {
        drop.alerted15m = true;
        this._save();
        const mins = Math.ceil(diffSec / 60);
        await this._sendAlert(
          `⏰ <b>DROP PHASE ALERT: 15m to Public Mint!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📦 <b>Collection:</b> <b>${drop.name}</b>\n` +
          `⏳ <b>Public Starts In:</b> <code>~${mins} minutes</code>\n` +
          `💰 <b>Expected Price:</b> <code>${drop.publicPrice}</code>\n` +
          `🎯 <b>Contract:</b> <code>${drop.contractAddress || drop.slug}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>Get your wallets ready or arm the sniper ahead of time.</i>`,
          drop
        );
      }

      // 2. T-5 minutes Alert
      if (diffSec <= 300 && diffSec > 0 && !drop.alerted5m) {
        drop.alerted5m = true;
        this._save();
        const mins = Math.ceil(diffSec / 60);
        await this._sendAlert(
          `⚠️ <b>HIGH ALERT: 5 MINUTES TO PUBLIC MINT!</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `📦 <b>Collection:</b> <b>${drop.name}</b>\n` +
          `⏳ <b>Public Opens In:</b> <code>${mins} minute(s)</code>!\n` +
          `💰 <b>Price:</b> <code>${drop.publicPrice}</code>\n` +
          `🎯 <b>Contract:</b> <code>${drop.contractAddress || drop.slug}</code>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `<i>The bot is standing by to blast transactions at T-0.</i>`,
          drop
        );
      }

      // 3. T-0 Public Phase is NOW LIVE Alert
      if (diffSec <= 0 && !drop.alertedLive) {
        drop.alertedLive = true;
        this._save();
        // Only send live alert if within 10 minutes of opening (avoid alerting ancient drops)
        if (diffSec >= -600) {
          await this._sendAlert(
            `🟢 <b>PUBLIC MINT IS NOW LIVE!</b>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `📦 <b>Collection:</b> <b>${drop.name}</b>\n` +
            `🚀 <b>Status:</b> <b>Public Stage is OPEN!</b>\n` +
            `💰 <b>Price:</b> <code>${drop.publicPrice}</code>\n` +
            `🎯 <b>Contract:</b> <code>${drop.contractAddress || drop.slug}</code>\n` +
            `━━━━━━━━━━━━━━━━━━━━\n` +
            `<i>Tap below to snipe immediately across your burner wallets!</i>`,
            drop,
            true
          );
        }
      }
    }

    // Prune drops older than 12 hours
    const prevCount = this.trackedDrops.length;
    this.trackedDrops = this.trackedDrops.filter(d => !d.publicStartTime || (nowSec - d.publicStartTime) < 43200);
    if (this.trackedDrops.length !== prevCount) {
      this._save();
    }
  }

  async _sendAlert(messageText, drop, isLive = false) {
    if (!this.client || !this.chatId) return;
    const keyboard = [
      [
        { text: `🎯 Snipe ${drop.name.slice(0, 15)}`, callback_data: `snipe_now_${drop.contractAddress || drop.slug}` }
      ]
    ];
    await this.client.sendMessage(this.chatId, messageText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(err => {
      logger.warn(`[DropTracker] Failed to send Telegram alert: ${err.message}`);
    });
  }
}

module.exports = new DropTrackerService();
