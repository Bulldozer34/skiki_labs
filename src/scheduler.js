const CollectionService = require('./services/collectionService');
const logger = require('./utils/logger');

/**
 * Auto-scheduler that polls OpenSea for drop schedule updates
 */
const Scheduler = {
  /**
   * Monitor drop start time until mint opens, adapting if the creator delays or updates the time
   * @param {string} slug 
   * @param {object} authHeaders 
   * @param {number} stageIndex 
   * @param {number} maxRetries - Max poll attempts before giving up (default 20 = ~10 min)
   * @returns {Promise<number>} Resolved start timestamp (seconds)
   */
  async autoSchedule(slug, authHeaders, stageIndex = 0, maxRetries = 20) {
    logger.info(`Auto-scheduling: Monitoring drop "${slug}" for stage start time...`);
    
    let lastStartTime = null;
    let retryCount = 0;
    let failCount = 0;

    while (retryCount < maxRetries) {
      retryCount++;
      const dropInfo = await CollectionService.getDropInfo(slug, authHeaders);
      
      if (!dropInfo || !dropInfo.stages || dropInfo.stages.length === 0) {
        failCount++;
        if (failCount >= 5) {
          logger.error(`Auto-schedule failed: Could not fetch drop schedule after ${failCount} consecutive failures.`);
          logger.warn('Possible causes: invalid slug, OpenSea GraphQL changed, or no API key set.');
          logger.warn('Tip: Use "Specific Start Time" mode instead, or check your OPENSEA_API_KEY in .env');
          throw new Error(`Auto-schedule gave up after ${failCount} failed API calls. Use CUSTOM_TIME mode.`);
        }
        logger.warn(`Could not fetch stage schedule (attempt ${failCount}/5). Retrying in 15 seconds...`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }

      // Reset fail counter on success
      failCount = 0;

      const targetStage = dropInfo.stages[stageIndex] || dropInfo.stages[0];
      const startTimeSeconds = Math.floor(new Date(targetStage.startTime).getTime() / 1000);
      const now = Math.floor(Date.now() / 1000);

      if (lastStartTime === null || lastStartTime !== startTimeSeconds) {
        lastStartTime = startTimeSeconds;
        const remaining = startTimeSeconds - now;
        if (remaining > 0) {
          logger.timer(`[Schedule] Stage "${targetStage.name}" set to start at: ${new Date(targetStage.startTime).toLocaleString()} (in ${remaining}s)`);
        } else {
          logger.success(`[Schedule] Stage "${targetStage.name}" is already LIVE!`);
          return startTimeSeconds;
        }
      }

      const remaining = startTimeSeconds - now;

      // If we are within 2 minutes of the mint, stop polling and lock in
      if (remaining <= 120) {
        logger.info('T-2m reached. Locking in schedule for warm-up phase.');
        return startTimeSeconds;
      }

      // Otherwise poll every 30 seconds for any creator delay/schedule adjustments
      logger.info(`[Schedule] Poll ${retryCount}/${maxRetries} — next check in 30s...`);
      await new Promise(r => setTimeout(r, 30000));
    }

    logger.error(`Auto-schedule timed out after ${maxRetries} polls (~${Math.round(maxRetries * 30 / 60)} min).`);
    throw new Error('Auto-schedule polling limit reached. Use CUSTOM_TIME mode instead.');
  }
};

module.exports = Scheduler;
