const fs = require('fs');
const path = require('path');

/**
 * BigInt-safe JSON replacer function to serialize BigInt values as strings.
 *
 * @param {string} k - Property key.
 * @param {*} v - Property value.
 * @returns {*} Serialized value with BigInt converted to string.
 */
const bigIntReplacer = (k, v) => (typeof v === 'bigint' ? v.toString() : v);

/**
 * Async buffered file writer for persisting data without blocking the event loop.
 */
class AsyncWriter {
  /**
   * Creates an instance of AsyncWriter.
   *
   * @param {string} filePath - Target file path.
   * @param {object} [options={}] - Configuration options.
   * @param {number} [options.flushIntervalMs=1000] - Interval in milliseconds for automatic flushing.
   */
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.flushIntervalMs = (options && options.flushIntervalMs) ? options.flushIntervalMs : 1000;
    this.queue = [];
    this.flushTimer = null;
    this.isFlushing = false;
    this.flushPromise = null;
  }

  /**
   * Pushes data into the write queue and auto-flushes if queue length reaches 5 or more.
   *
   * @param {*} data - Data item or array of items to buffer.
   */
  write(data) {
    if (data === undefined) {
      return;
    }

    if (Array.isArray(data)) {
      this.queue.push(...data);
    } else {
      this.queue.push(data);
    }

    if (this.queue.length >= 5) {
      this.flush().catch((err) => {
        console.error(`[AsyncWriter] Auto-flush error for ${this.filePath}:`, err);
      });
    }
  }

  /**
   * Flushes queued data to file asynchronously using fs.promises.writeFile.
   * Uses BigInt-safe serialization and clears written items from the queue upon success.
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.queue.length === 0) {
      return;
    }

    if (this.isFlushing) {
      try {
        await this.flushPromise;
      } catch (err) {
        // Error already handled and logged in the in-flight flush
      }
      if (this.queue.length === 0) {
        return;
      }
    }

    this.isFlushing = true;
    this.flushPromise = (async () => {
      const itemsToWrite = [...this.queue];
      try {
        // Ensure destination directory exists
        const resolvedPath = path.resolve(this.filePath);
        const dir = path.dirname(resolvedPath);
        try {
          if (!fs.existsSync(dir)) {
            await fs.promises.mkdir(dir, { recursive: true });
          }
        } catch (dirErr) {
          console.error(`[AsyncWriter] Failed to create directory for ${this.filePath}:`, dirErr);
        }

        // Read existing file content if available to append history
        let existingData = [];
        try {
          if (fs.existsSync(this.filePath)) {
            const fileContent = await fs.promises.readFile(this.filePath, 'utf8');
            if (fileContent.trim()) {
              const parsed = JSON.parse(fileContent);
              existingData = Array.isArray(parsed) ? parsed : [parsed];
            }
          }
        } catch (readErr) {
          console.error(`[AsyncWriter] Failed to read existing file ${this.filePath}:`, readErr);
          existingData = [];
        }

        // Combine existing data with queued items
        const combinedData = existingData.concat(itemsToWrite);

        const jsonString = JSON.stringify(combinedData, bigIntReplacer, 2);
        await fs.promises.writeFile(this.filePath, jsonString, 'utf8');

        // Remove only successfully written items from the queue
        this.queue.splice(0, itemsToWrite.length);
      } catch (writeErr) {
        console.error(`[AsyncWriter] Failed to write data to ${this.filePath}:`, writeErr);
      } finally {
        this.isFlushing = false;
      }
    })();

    try {
      await this.flushPromise;
    } catch (err) {
      console.error(`[AsyncWriter] Flush execution failed for ${this.filePath}:`, err);
    }
  }

  /**
   * Convenience method that adds an entry and flushes immediately.
   *
   * @param {*} data - Data item or array of items to append.
   * @returns {Promise<void>}
   */
  async append(data) {
    this.write(data);
    return await this.flush();
  }

  /**
   * Starts automatic background flushing at regular intervals.
   */
  startAutoFlush() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error(`[AsyncWriter] Auto-flush error for ${this.filePath}:`, err);
      });
    }, this.flushIntervalMs);

    if (this.flushTimer.unref) {
      this.flushTimer.unref();
    }
  }

  /**
   * Clears the auto-flush interval and performs a final flush of all queued items.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    return await this.flush();
  }
}

/**
 * Singleton helper instance for mint history logging.
 */
const mintHistoryWriter = new AsyncWriter('mint-history.json');

module.exports = {
  AsyncWriter,
  mintHistoryWriter
};
