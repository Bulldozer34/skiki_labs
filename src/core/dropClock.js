const os = require('os');
const chalk = require('chalk');
const logger = require('../utils/logger');

/**
 * Shared high-precision drop clock.
 *
 * Every mint engine needs the same countdown: run a ladder of warmup milestones
 * at fixed offsets before the drop, then hand control back at T-minus the lead
 * time with nanosecond accuracy. This module owns that timing so the engines
 * only supply the work to do at each milestone.
 *
 * Three details matter for landing in Block 0:
 *
 *  - The OS scheduler is the dominant source of error, not Node. Both the
 *    milestone timers and the spin loop are really competing with every other
 *    process for a core, so the clock raises its own priority class first —
 *    see `raiseProcessPriority`, which is worth two orders of magnitude.
 *  - `setTimeout` resolution on Windows is coarse (~15ms) and drifts under load,
 *    which is enough to miss a 40-supply drop entirely. The final approach is
 *    therefore a `process.hrtime.bigint()` spin loop that burns CPU rather than
 *    yielding to the event loop.
 *  - Firing exactly on the drop timestamp is already too late: the transaction
 *    still has to travel to the sequencer. `SNIPER_LEAD_TIME_MS` shifts the
 *    trigger earlier to cover that flight time.
 */

/**
 * How long before the fire instant we stop trusting `setTimeout` and start
 * spinning.
 *
 * Two errors pull this in opposite directions, and both were measured on
 * Windows 10 under load (200 samples per cell, see the priority note below):
 *
 *  - Too short and the final `setTimeout` overshoots straight past the fire
 *    instant, which is the one error a spin loop cannot correct — arriving
 *    early is free, arriving late has already cost the drop. Worst overshoot
 *    for a 50ms sleep was 85ms with priority raised.
 *  - Too long and the spin itself becomes the risk: it holds a core for the
 *    whole window, so every extra millisecond is more exposure to being
 *    descheduled right at the end. `spinFor(250)` measured an 11ms tail versus
 *    0.7ms for `spinFor(120)`.
 *
 * 150ms sits above the worst observed overshoot with ~1.8x margin while
 * staying in the range where spin exposure is still unmeasurable.
 */
const DEFAULT_SPIN_WINDOW_MS = 150;

/** Cadence cap once the drop is close, so the countdown display stays live. */
const CLOSE_RANGE_MS = 10000;
const CLOSE_RANGE_TICK_MS = 50;
const FAR_RANGE_TICK_MS = 1000;

/**
 * Lead time in ms to fire before the drop timestamp, from SNIPER_LEAD_TIME_MS.
 *
 * The correct value is one *one-way* network flight to the sequencer, so the
 * transaction touches the ingress the instant the drop opens. Fire too late and
 * a competitor is ahead of you in the FIFO queue; fire too early and the
 * contract reverts `NotActive()` and burns the nonce.
 *
 * 35ms is only right for a host a few hops from the sequencer. From a home
 * connection the flight is ~120ms, so leave this unset and let the engine
 * calibrate it from a live measurement — see `calibrateLeadTimeMs`.
 *
 * @returns {number}
 */
function resolveLeadTimeMs() {
  const raw = (process.env.SNIPER_LEAD_TIME_MS || '').trim().toLowerCase();
  if (raw && raw !== 'auto') {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 15;
}

/** Bounds on a calibrated lead time, so a freak measurement can't fire wild. */
const MIN_CALIBRATED_LEAD_MS = 3;
const MAX_CALIBRATED_LEAD_MS = 400;

/**
 * Turn a measured round-trip into a lead time.
 *
 * Half the round-trip is the one-way flight, which is the distance we need to
 * cover. If SNIPER_LEAD_TIME_MS is explicitly set to a number (not 'auto'), that
 * override wins. When set to 'auto' or empty, live RTT calibration takes effect.
 *
 * @param {number|null} roundTripMs Median RTT to the broadcast endpoint
 * @returns {{leadTimeMs: number, source: string}}
 */
function calibrateLeadTimeMs(roundTripMs) {
  const explicit = (process.env.SNIPER_LEAD_TIME_MS || '').trim().toLowerCase();
  if (explicit && explicit !== 'auto') {
    const parsed = parseInt(explicit, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return { leadTimeMs: parsed, source: 'SNIPER_LEAD_TIME_MS override' };
    }
  }
  if (!Number.isFinite(roundTripMs) || roundTripMs <= 0) {
    return { leadTimeMs: resolveLeadTimeMs(), source: 'default (probe failed)' };
  }
  // Half RTT is the one-way flight time. Add 1ms buffer so packet touches sequencer NIC right as block opens
  const oneWay = Math.ceil(roundTripMs / 2) + 1;
  const clamped = Math.min(MAX_CALIBRATED_LEAD_MS, Math.max(MIN_CALIBRATED_LEAD_MS, oneWay));
  return { leadTimeMs: clamped, source: `auto-calibrated (${Math.round(roundTripMs)}ms RTT -> ${clamped}ms lead)` };
}

/** Memoized so the attempt and its log line happen once per process. */
let priorityBoost = null;

/**
 * Ask the OS to stop descheduling us.
 *
 * Neither the spin loop nor the milestone timers are really fighting Node —
 * they are fighting the scheduler handing our core to something else. Measured
 * on Windows 10 under deliberate event-loop load, 200 samples per cell
 * (2026-08-31):
 *
 *                          normal      HIGH
 *     spinFor(120)  max     86ms       0.7ms
 *     spinFor(250)  max    530ms      11.1ms
 *     setTimeout(50) max   574ms      85.2ms
 *
 * So this is worth far more than any tuning of the spin window, and it is the
 * difference between a trigger that is reliably sub-millisecond and one that
 * misses a 40-supply drop a few percent of the time.
 *
 * Best effort by design: a negative nice value needs root or CAP_SYS_NICE on
 * Linux, so on the EC2 target this may simply fail. That costs a few
 * milliseconds of jitter, which is not worth aborting a snipe over.
 *
 * @returns {{applied: boolean, level?: string, value?: number, reason?: string}}
 */
function raiseProcessPriority() {
  if (priorityBoost !== null) return priorityBoost;

  if (['0', 'false', 'no'].includes(String(process.env.SNIPER_PRIORITY_BOOST || '').toLowerCase())) {
    return (priorityBoost = { applied: false, reason: 'disabled' });
  }

  // HIGH, never HIGHEST: -20 maps to REALTIME_PRIORITY_CLASS on Windows, which
  // outranks input and disk threads and can wedge the whole machine while we spin.
  for (const level of ['PRIORITY_HIGH', 'PRIORITY_ABOVE_NORMAL']) {
    try {
      os.setPriority(0, os.constants.priority[level]);
      priorityBoost = { applied: true, level, value: os.getPriority(0) };
      logger.info(
        `Scheduler priority raised to ${level.replace('PRIORITY_', '').toLowerCase()} ` +
        `(${priorityBoost.value}) — keeps the trigger off the OS run queue.`
      );
      return priorityBoost;
    } catch (err) {
      priorityBoost = { applied: false, reason: err.code || err.message };
    }
  }

  logger.warn(
    `Could not raise scheduler priority (${priorityBoost.reason}) — expect a few ms of ` +
    'extra timer jitter. On Linux, run as root or grant the binary CAP_SYS_NICE.'
  );
  return priorityBoost;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function abortableSleep(ms, signal) {
  if (!signal) return sleep(ms);
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const err = new Error('Snipe countdown cancelled by user');
      err.name = 'AbortError';
      return reject(err);
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      const err = new Error('Snipe countdown cancelled by user');
      err.name = 'AbortError';
      reject(err);
    }, { once: true });
  });
}

/**
 * Block the thread until `ms` from now, accurate to the nanosecond clock.
 * @param {number} ms Negative or zero returns immediately.
 */
function spinFor(ms) {
  const waitNs = BigInt(Math.max(0, Math.floor(ms))) * 1000000n;
  if (waitNs === 0n) return;
  const targetHr = process.hrtime.bigint() + waitNs;
  while (process.hrtime.bigint() < targetHr) {
    // High-frequency nanosecond spin loop — deliberately busy
  }
}

/**
 * How long we can sleep without overshooting the spin window, the next
 * milestone, or the early-trigger polling window.
 */
function nextTickMs({ now, deadlineMs, targetFireMs, spinWindowMs, milestones, done, earlyTrigger }) {
  const remainingMs = deadlineMs - now;
  let wake = (targetFireMs - spinWindowMs) - now;

  for (const milestone of milestones) {
    if (done.has(milestone)) continue;
    const untilMilestone = remainingMs - milestone.atMs;
    if (untilMilestone >= 0 && untilMilestone < wake) {
      wake = untilMilestone;
    }
  }

  if (earlyTrigger) {
    const untilWindow = remainingMs - earlyTriggerWindowMs(earlyTrigger);
    if (untilWindow >= 0 && untilWindow < wake) {
      wake = untilWindow;
    } else if (untilWindow < 0) {
      // Already inside the window: keep polling tightly
      wake = Math.min(wake, CLOSE_RANGE_TICK_MS);
    }
  }

  const cap = remainingMs <= CLOSE_RANGE_MS ? CLOSE_RANGE_TICK_MS : FAR_RANGE_TICK_MS;
  return Math.max(5, Math.min(wake, cap));
}

function earlyTriggerWindowMs(earlyTrigger) {
  return earlyTrigger && earlyTrigger.withinMs != null ? earlyTrigger.withinMs : 2500;
}

/**
 * @typedef {Object} DropMilestone
 * @property {number} atMs Fire once the remaining time drops to or below this
 * @property {string} label Shown in the countdown line, e.g. 'T-15s: Refreshing nonces'
 * @property {(ctx: {remainingMs: number, deadlineMs: number, leadTimeMs: number}) => any} run
 *   Work to perform. Awaited; may run long (even past the deadline) and may
 *   throw — the clock swallows errors so warmup can never abort a snipe.
 */

/**
 * @typedef {Object} DropEarlyTrigger
 * @property {number} [withinMs=2500] Only start polling this close to the deadline
 * @property {() => (boolean|Promise<boolean>)} check Return true to fire right now
 * @property {string} [message] Countdown line shown when it fires
 */

/**
 * Wait until it is time to broadcast.
 *
 * @param {Object} options
 * @param {number} options.deadlineMs Drop time as epoch ms. Past/zero returns immediately.
 * @param {DropMilestone[]} [options.milestones] Warmup ladder, any order.
 * @param {DropEarlyTrigger|null} [options.earlyTrigger] Escape hatch to fire before the clock,
 *   e.g. the sequencer's own block timestamp having already reached the drop time.
 * @param {number|(() => number)} [options.leadTimeMs] Defaults to SNIPER_LEAD_TIME_MS. A
 *   function is re-read on every pass, so a warmup milestone can calibrate the
 *   lead time from a live latency probe and have it take effect.
 * @param {number} [options.spinWindowMs=150] See DEFAULT_SPIN_WINDOW_MS.
 * @param {string} [options.label='Drop'] Noun used in countdown output.
 * @returns {Promise<{reason: 'immediate'|'early'|'spin', leadTimeMs: number, firedAtMs: number, overshootMs: number}>}
 *   `overshootMs` is how late the trigger was versus the intended fire instant —
 *   0 on a clean spin, positive if a milestone ran long.
 */
async function waitForDropWindow({
  deadlineMs,
  milestones = [],
  earlyTrigger = null,
  leadTimeMs = null,
  spinWindowMs = DEFAULT_SPIN_WINDOW_MS,
  label = 'Drop',
  signal = null
} = {}) {
  // Re-read every pass: a milestone may calibrate this mid-countdown, and the
  // fire instant has to move with it.
  const readLead = () => {
    const raw = typeof leadTimeMs === 'function' ? leadTimeMs() : leadTimeMs;
    return raw == null || !Number.isFinite(raw) ? resolveLeadTimeMs() : Math.max(0, raw);
  };

  let lead = readLead();
  let targetFireMs = (deadlineMs || 0) - lead;

  if (!deadlineMs || deadlineMs <= Date.now()) {
    return { reason: 'immediate', leadTimeMs: lead, firedAtMs: Date.now(), overshootMs: 0 };
  }

  // Raised for the whole countdown, not just the spin: the warmup milestones
  // are timed off `setTimeout` too, and the broadcast that follows the trigger
  // wants the same protection from being descheduled.
  raiseProcessPriority();

  // Largest offset first, so an overdue ladder still drains in the right order
  const ladder = milestones
    .filter(m => m && typeof m.run === 'function' && Number.isFinite(m.atMs))
    .slice()
    .sort((a, b) => b.atMs - a.atMs);
  const done = new Set();

  logger.timer(
    `${label} starts at ${new Date(deadlineMs).toLocaleTimeString()} ` +
    `(in ${logger.formatDuration(Math.ceil((deadlineMs - Date.now()) / 1000))}) [Lead-Time: ${lead}ms]`
  );

  const finish = (reason) => {
    const firedAtMs = Date.now();
    return {
      reason,
      leadTimeMs: lead,
      firedAtMs,
      overshootMs: Math.max(0, firedAtMs - targetFireMs)
    };
  };

  for (;;) {
    if (signal && signal.aborted) {
      const err = new Error('Snipe countdown cancelled by user');
      err.name = 'AbortError';
      throw err;
    }

    let now = Date.now();
    const remainingMs = deadlineMs - now;

    // A milestone may have recalibrated the lead time from a live latency probe.
    lead = readLead();
    targetFireMs = deadlineMs - lead;

    // 1. Warmup ladder. Run at most one per pass, then re-read the clock —
    //    a milestone can take seconds, so any decision made after it must use
    //    fresh time rather than the value sampled before the await.
    const due = ladder.find(m => !done.has(m) && remainingMs <= m.atMs);
    if (due) {
      done.add(due);
      process.stdout.write(
        `\r${chalk.blue('[timer]')} ${chalk.yellow(logger.formatDuration(remainingMs / 1000, true))}` +
        ` [${due.label}...]    \n`
      );
      try {
        await due.run({ remainingMs, deadlineMs, leadTimeMs: lead });
      } catch (err) {
        logger.warn(`${due.label} failed (continuing): ${err.message}`);
      }
      continue;
    }

    // 2. Early trigger — the drop may already be live on the sequencer
    if (earlyTrigger && typeof earlyTrigger.check === 'function' && remainingMs <= earlyTriggerWindowMs(earlyTrigger)) {
      let hit = false;
      try {
        hit = await earlyTrigger.check({ remainingMs, deadlineMs });
      } catch (err) {
        hit = false;
      }
      if (hit) {
        process.stdout.write(
          `\r${chalk.blue('[timer]')} ` +
          `${chalk.green(earlyTrigger.message || '⚡ Early trigger fired! Launching instant blast...')}    \n`
        );
        return finish('early');
      }
      now = Date.now(); // the check cost a network round-trip
    }

    // 3. Terminal approach — stop yielding to the event loop
    const toFireMs = targetFireMs - now;
    if (toFireMs <= spinWindowMs) {
      spinFor(toFireMs);
      process.stdout.write(
        `\r${chalk.blue('[timer]')} ${chalk.green(`🎯 Eager trigger reached (T-${lead}ms lead-time)! Firing...`)}    \n`
      );
      return finish('spin');
    }

    process.stdout.write(
      `\r${chalk.blue('[timer]')} ${label} starts in ` +
      `${chalk.yellow(logger.formatDuration((deadlineMs - now) / 1000, true))}...    `
    );
    await abortableSleep(nextTickMs({ now, deadlineMs, targetFireMs, spinWindowMs, milestones: ladder, done, earlyTrigger }), signal);
  }
}

module.exports = {
  waitForDropWindow,
  resolveLeadTimeMs,
  calibrateLeadTimeMs,
  raiseProcessPriority,
  spinFor,
  DEFAULT_SPIN_WINDOW_MS
};
