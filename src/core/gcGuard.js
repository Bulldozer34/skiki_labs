const v8 = require('v8');
const vm = require('vm');
const logger = require('../utils/logger');

/**
 * V8 garbage-collection guard.
 *
 * The drop trigger is a `process.hrtime.bigint()` spin loop that must hand off to
 * a broadcast within a few hundred microseconds. Two things can freeze that
 * window, and the OS scheduler (handled in `dropClock.raiseProcessPriority`) is
 * only one of them — the other is V8 deciding to collect.
 *
 * Why it lands exactly then: the whole warmup phase is allocation-heavy. Signing
 * N transactions, re-signing them at T-15s, building JSON-RPC buffers, DNS
 * lookups, socket warming and the pre-flight simulation all churn the young
 * generation. By T-0 the semi-space is typically near full, so the *next*
 * allocation triggers a scavenge — and the next allocation is the broadcast.
 * A scavenge is usually 1-5ms, but a major (mark-compact) collection on a heap
 * this size runs 10-40ms. On a chain producing ~11 blocks/second, 40ms is four
 * blocks of other people's transactions inserted ahead of ours.
 *
 * The fix is to collect on *our* schedule instead of V8's: force a full
 * compacting collection while there is still slack (T-0.8s), which empties the
 * young generation and leaves the critical window with room to allocate into.
 * That converts an unpredictable 40ms freeze at the worst possible instant into
 * a predictable one 800ms early, where it costs nothing.
 *
 * `global.gc` normally requires launching node with `--expose-gc`. Rather than
 * depend on how the operator starts the bot, this enables the flag at runtime,
 * captures the function out of a fresh context, then turns the flag back off so
 * nothing else in the process is handed a `gc()` global.
 */

/** Memoized GC handle; `false` once we know it is unobtainable. */
let gcFn = null;

/**
 * Obtain a callable full-GC function without requiring `--expose-gc`.
 * @returns {Function|null}
 */
function resolveGc() {
  if (gcFn !== null) return gcFn || null;

  if (typeof global.gc === 'function') {
    gcFn = global.gc;
    return gcFn;
  }

  try {
    v8.setFlagsFromString('--expose_gc');
    const fn = vm.runInNewContext('gc');
    gcFn = typeof fn === 'function' ? fn : false;
  } catch (err) {
    gcFn = false;
  } finally {
    // Put the flag back so the rest of the process does not silently gain a
    // `gc()` global it was never written to expect.
    try { v8.setFlagsFromString('--no-expose_gc'); } catch (err) {}
  }

  return gcFn || null;
}

/**
 * Force a full compacting collection now, so V8 does not choose to do it during
 * the drop. Safe to call when GC is unavailable — it simply reports that.
 *
 * @param {string} [reason] Included in the log line
 * @returns {{applied: boolean, durationMs?: number, freedMb?: number, heapMb?: number}}
 */
function quiesce(reason = 'pre-drop') {
  const gc = resolveGc();
  if (!gc) {
    return { applied: false };
  }

  const heapBefore = process.memoryUsage().heapUsed;
  const startedAt = process.hrtime.bigint();
  try {
    gc();
  } catch (err) {
    return { applied: false };
  }
  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  const heapAfter = process.memoryUsage().heapUsed;

  const result = {
    applied: true,
    durationMs: Math.round(durationMs * 100) / 100,
    freedMb: Math.round(((heapBefore - heapAfter) / 1048576) * 10) / 10,
    heapMb: Math.round((heapAfter / 1048576) * 10) / 10
  };

  logger.speed(
    `GC quiesced (${reason}): ${result.durationMs}ms pause taken now, ` +
    `${result.freedMb}MB freed, heap ${result.heapMb}MB — ` +
    'young generation empty entering the trigger.'
  );
  return result;
}

/**
 * Heap headroom advice, printed once at startup.
 *
 * `--max-semi-space-size` cannot be changed after V8 has started, so a larger
 * young generation has to come from the launch environment. Bumping it from the
 * default 16MB to 64MB means the warmup phase's allocation churn fits without a
 * single scavenge, which is strictly better than collecting well. This only
 * reports; it never re-execs the process behind the operator's back.
 *
 * @returns {{tuned: boolean, semiSpaceMb: number|null}}
 */
function reportHeapTuning() {
  const nodeOptions = process.env.NODE_OPTIONS || '';
  const argv = process.execArgv.join(' ');
  const combined = `${nodeOptions} ${argv}`;

  const match = combined.match(/--max[-_]semi[-_]space[-_]size[= ](\d+)/);
  if (match) {
    return { tuned: true, semiSpaceMb: Number(match[1]) };
  }

  logger.info(
    'Tip: launch with NODE_OPTIONS="--max-semi-space-size=64" to give the warmup ' +
    'phase enough young-generation room to avoid GC pauses near the drop.'
  );
  return { tuned: false, semiSpaceMb: null };
}

module.exports = { quiesce, resolveGc, reportHeapTuning };
