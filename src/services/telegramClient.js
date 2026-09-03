const axios = require('axios');
const logger = require('../utils/logger');

/**
 * Lightweight Telegram Bot API Client.
 *
 * Implements Bot API communication over native axios with long-polling (getUpdates).
 * No external bot framework dependencies required.
 */
class TelegramClient {
  /**
   * @param {string} token Telegram Bot Token from @BotFather
   */
  constructor(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('Telegram Bot Token is required.');
    }
    this.token = token.trim();
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;
    this.axiosInstance = axios.create({
      baseURL: this.baseUrl,
      timeout: 45000 // 45s timeout for long-polling (max poll is 30s)
    });
  }

  /**
   * Send a text message to a chat.
   * @param {string|number} chatId
   * @param {string} text
   * @param {object} [options={}]
   * @param {string} [options.parse_mode='HTML']
   * @param {object} [options.reply_markup]
   * @returns {Promise<object>} Telegram Message object
   */
  async sendMessage(chatId, text, options = {}) {
    try {
      const payload = {
        chat_id: chatId,
        text,
        parse_mode: options.parse_mode !== undefined ? options.parse_mode : 'HTML',
        disable_web_page_preview: options.disable_web_page_preview ?? true,
        ...options
      };
      const res = await this.axiosInstance.post('/sendMessage', payload);
      return res.data?.result;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.error(`[TelegramClient] sendMessage failed: ${errDetail}`);
      throw new Error(errDetail);
    }
  }

  /**
   * Edit an existing message's text.
   * @param {string|number} chatId
   * @param {number} messageId
   * @param {string} text
   * @param {object} [options={}]
   * @returns {Promise<object>}
   */
  async editMessageText(chatId, messageId, text, options = {}) {
    try {
      const payload = {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: options.parse_mode !== undefined ? options.parse_mode : 'HTML',
        disable_web_page_preview: options.disable_web_page_preview ?? true,
        ...options
      };
      const res = await this.axiosInstance.post('/editMessageText', payload);
      return res.data?.result;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      // Ignore errors caused by message content being unchanged
      if (errDetail.includes('message is not modified')) {
        return null;
      }
      logger.warn(`[TelegramClient] editMessageText failed: ${errDetail}`);
      throw new Error(errDetail);
    }
  }

  /**
   * Send a document/file (e.g. SVG card or JSON export) to a chat.
   * @param {string|number} chatId
   * @param {Buffer|string} fileContent File buffer or string
   * @param {string} filename File name (e.g. "pnl_card.svg")
   * @param {string} [caption=''] Optional caption
   * @param {object} [options={}]
   * @returns {Promise<object>} Telegram Message object
   */
  async sendDocument(chatId, fileContent, filename, caption = '', options = {}) {
    try {
      const formData = new FormData();
      formData.append('chat_id', String(chatId));
      const blob = new Blob([fileContent]);
      formData.append('document', blob, filename);
      if (caption) {
        formData.append('caption', caption);
        formData.append('parse_mode', options.parse_mode || 'HTML');
      }
      if (options.reply_markup) {
        formData.append('reply_markup', typeof options.reply_markup === 'string' ? options.reply_markup : JSON.stringify(options.reply_markup));
      }
      const res = await this.axiosInstance.post('/sendDocument', formData, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });
      return res.data?.result;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.error(`[TelegramClient] sendDocument failed: ${errDetail}`);
      throw new Error(errDetail);
    }
  }

  /**
   * Send a photo to a chat (via URL or buffer).
   * @param {string|number} chatId
   * @param {string|Buffer} photo URL string or image Buffer
   * @param {string} [caption=''] Optional caption
   * @param {object} [options={}]
   * @returns {Promise<object>} Telegram Message object
   */
  async sendPhoto(chatId, photo, caption = '', options = {}) {
    try {
      // Safe truncate caption to Telegram's 1024-character maximum
      let safeCaption = caption;
      if (safeCaption && safeCaption.length > 1020) {
        safeCaption = safeCaption.slice(0, 1017) + '...';
      }

      // If photo is an HTTP URL, fetch its buffer first so Telegram receives native image binary
      let photoBuffer = photo;
      if (typeof photo === 'string' && photo.startsWith('http')) {
        try {
          const axios = require('axios');
          const dl = await axios.get(photo, { responseType: 'arraybuffer', timeout: 8000 });
          photoBuffer = Buffer.from(dl.data);
        } catch (fetchErr) {
          logger.warn(`[TelegramClient] Failed to fetch photo URL, passing URL directly: ${fetchErr.message}`);
          photoBuffer = photo;
        }
      }

      if (typeof photoBuffer === 'string') {
        const payload = {
          chat_id: chatId,
          photo: photoBuffer,
          caption: safeCaption,
          parse_mode: options.parse_mode || 'HTML',
          ...options
        };
        const res = await this.axiosInstance.post('/sendPhoto', payload);
        return res.data?.result;
      } else {
        const formData = new FormData();
        formData.append('chat_id', String(chatId));
        const blob = new Blob([photoBuffer]);
        formData.append('photo', blob, 'pnl_card.png');
        if (safeCaption) {
          formData.append('caption', safeCaption);
          formData.append('parse_mode', options.parse_mode || 'HTML');
        }
        if (options.reply_markup) {
          formData.append('reply_markup', typeof options.reply_markup === 'string' ? options.reply_markup : JSON.stringify(options.reply_markup));
        }
        const res = await this.axiosInstance.post('/sendPhoto', formData, {
          headers: { 'Content-Type': 'multipart/form-data' }
        });
        return res.data?.result;
      }
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.error(`[TelegramClient] sendPhoto failed: ${errDetail}`);
      throw new Error(errDetail);
    }
  }

  /**
   * Answer a callback query from an inline button tap.
   * @param {string} callbackQueryId
   * @param {object} [options={}]
   * @param {string} [options.text] Alert/toast text shown to user
   * @param {boolean} [options.show_alert=false] Show modal popup vs top banner
   * @returns {Promise<boolean>}
   */
  async answerCallbackQuery(callbackQueryId, options = {}) {
    try {
      const payload = {
        callback_query_id: callbackQueryId,
        ...options
      };
      const res = await this.axiosInstance.post('/answerCallbackQuery', payload);
      return !!res.data?.ok;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.warn(`[TelegramClient] answerCallbackQuery failed: ${errDetail}`);
      return false;
    }
  }

  /**
   * Delete a message.
   * @param {string|number} chatId
   * @param {number} messageId
   * @returns {Promise<boolean>}
   */
  async deleteMessage(chatId, messageId) {
    try {
      const res = await this.axiosInstance.post('/deleteMessage', {
        chat_id: chatId,
        message_id: messageId
      });
      return !!res.data?.ok;
    } catch (err) {
      return false;
    }
  }

  /**
   * Verify bot token and get bot identity.
   * @returns {Promise<object>} Bot user details
   */
  async getMe() {
    try {
      const res = await this.axiosInstance.get('/getMe');
      return res.data?.result;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      throw new Error(`Failed to authenticate with Telegram: ${errDetail}`);
    }
  }

  /**
   * Long-poll for updates from Telegram servers.
   * @param {number} offset Update ID offset to ack processed messages
   * @param {number} [timeout=30] Polling timeout in seconds
   * @returns {Promise<object[]>} Array of Update objects
   */
  async getUpdates(offset, timeout = 30) {
    try {
      const res = await this.axiosInstance.get('/getUpdates', {
        params: {
          offset,
          timeout,
          allowed_updates: JSON.stringify(['message', 'callback_query'])
        }
      });
      return res.data?.result || [];
    } catch (err) {
      if (err.response?.status === 429) {
        const retryAfter = err.response.data?.parameters?.retry_after || 5;
        logger.warn(`[TelegramClient] Rate limited by Telegram. Waiting ${retryAfter}s...`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        return [];
      }
      throw err;
    }
  }

  /**
   * Register bot commands so they appear as autocomplete suggestions
   * when the user types "/" in the chat input.
   * @param {Array<{command: string, description: string}>} commands
   * @param {object} [scope]
   * @returns {Promise<boolean>}
   */
  async setMyCommands(commands, scope = null) {
    try {
      const payload = { commands };
      if (scope) payload.scope = scope;
      const res = await this.axiosInstance.post('/setMyCommands', payload);
      return !!res.data?.ok;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.warn(`[TelegramClient] setMyCommands failed: ${errDetail}`);
      return false;
    }
  }

  /**
   * Configure the persistent Menu button in Telegram chat bar
   * @param {object} [menuButton]
   * @returns {Promise<boolean>}
   */
  async setChatMenuButton(menuButton = { type: 'commands' }) {
    try {
      const res = await this.axiosInstance.post('/setChatMenuButton', { menu_button: menuButton });
      return !!res.data?.ok;
    } catch (err) {
      const errDetail = err.response?.data?.description || err.message;
      logger.warn(`[TelegramClient] setChatMenuButton failed: ${errDetail}`);
      return false;
    }
  }
}

module.exports = TelegramClient;

