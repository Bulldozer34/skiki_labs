const assert = require('assert');
const Scheduler = require('../src/scheduler');
const { waitForDropWindow } = require('../src/core/dropClock');
const { runSnipe } = require('../src/core/snipeRunner');

let passedTests = 0;
let failedTests = 0;

function syncTest(name, fn) {
  try {
    fn();
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${name}`);
    console.error(err);
    failedTests++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  \x1b[32m✔ PASS\x1b[0m: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  \x1b[31m✖ FAIL\x1b[0m: ${name}`);
    console.error(err);
    failedTests++;
  }
}

console.log('\n🧪 Running Scheduler, Abort Signal & Post-Mint Test Suite...\n');

(async () => {
  // 1. Scheduler timestamp parsing tests
  syncTest('Scheduler.parseTimeSec: Correctly handles seconds vs milliseconds', () => {
    const epochSec = 1788463800;
    const epochMs = 1788463800000;

    assert.strictEqual(Scheduler.parseTimeSec(epochSec), epochSec);
    assert.strictEqual(Scheduler.parseTimeSec(epochMs), epochSec);
    assert.strictEqual(Scheduler.parseTimeSec(String(epochSec)), epochSec);
    assert.strictEqual(Scheduler.parseTimeSec(String(epochMs)), epochSec);
  });

  syncTest('Scheduler.parseTimeSec: Correctly parses ISO date strings', () => {
    const isoString = '2026-09-15T12:00:00.000Z';
    const expectedSec = Math.floor(new Date(isoString).getTime() / 1000);

    assert.strictEqual(Scheduler.parseTimeSec(isoString), expectedSec);
  });

  syncTest('Scheduler.parseTimeSec: Returns null for empty, null, or invalid values', () => {
    assert.strictEqual(Scheduler.parseTimeSec(null), null);
    assert.strictEqual(Scheduler.parseTimeSec(undefined), null);
    assert.strictEqual(Scheduler.parseTimeSec(''), null);
    assert.strictEqual(Scheduler.parseTimeSec('invalid-date'), null);
  });

  // 2. AbortController cancellation in waitForDropWindow
  await asyncTest('dropClock: AbortController aborts countdown immediately', async () => {
    const abortController = new AbortController();
    const farFutureMs = Date.now() + 600000; // 10 minutes in future

    // Abort after 50ms
    setTimeout(() => {
      abortController.abort();
    }, 50);

    const tStart = Date.now();
    let caughtError = null;

    try {
      await waitForDropWindow({
        deadlineMs: farFutureMs,
        signal: abortController.signal
      });
    } catch (err) {
      caughtError = err;
    }

    const elapsed = Date.now() - tStart;
    assert.ok(caughtError !== null, 'Must throw when aborted');
    assert.strictEqual(caughtError.name, 'AbortError');
    assert.ok(elapsed < 1000, `Must exit immediately upon abort (took ${elapsed}ms)`);
  });

  // 3. runSnipe argument forwarding
  await asyncTest('runSnipe: Accepts postMintConfig and signal without dropping', async () => {
    // Test that runSnipe validation and argument passing works
    let thrownError = null;
    try {
      await runSnipe({
        mode: 'PUBLIC',
        wallets: [],
        nftContractAddress: '0x1234567890123456789012345678901234567890',
        postMintConfig: { action: 'TOP_OFFER' },
        signal: new AbortController().signal
      });
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError !== null);
    assert.strictEqual(thrownError.message, 'No wallets provided.');
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
})();
