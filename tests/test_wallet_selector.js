/**
 * Test Suite — Wallet Number Selector & Parser.
 */

const assert = require('assert');
const { parseWalletNumbers, formatWalletNumbers } = require('../src/utils/walletSelector');

let passedTests = 0;
let failedTests = 0;

function test(name, fn) {
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

console.log('\n🧪 Running Wallet Number Selector Test Suite...\n');

// 1. Specific numbers
test('parseWalletNumbers: Correctly parses single numbers (e.g. "1, 3, 7")', () => {
  const res = parseWalletNumbers('1, 3, 7', 10);
  assert.deepStrictEqual(res, [0, 2, 6]);
});

// 2. Ranges
test('parseWalletNumbers: Correctly parses ranges (e.g. "1-5")', () => {
  const res = parseWalletNumbers('1-5', 20);
  assert.deepStrictEqual(res, [0, 1, 2, 3, 4]);
});

// 3. Mixed ranges and single numbers
test('parseWalletNumbers: Correctly parses mixed ranges and single numbers (e.g. "1-3, 5, 8-10")', () => {
  const res = parseWalletNumbers('1-3, 5, 8-10', 20);
  assert.deepStrictEqual(res, [0, 1, 2, 4, 7, 8, 9]);
});

// 4. Special keywords
test('parseWalletNumbers: Correctly handles "all" and "none"', () => {
  const allRes = parseWalletNumbers('all', 5);
  assert.deepStrictEqual(allRes, [0, 1, 2, 3, 4]);

  const noneRes = parseWalletNumbers('none', 5);
  assert.deepStrictEqual(noneRes, []);
});

// 5. Formatting
test('formatWalletNumbers: Formats numbers into human-readable strings', () => {
  const f1 = formatWalletNumbers([0, 2, 6], 10);
  assert.strictEqual(f1, '#1, #3, #7 (3 wallets)');

  const f2 = formatWalletNumbers([0, 1, 2, 3, 4], 20);
  assert.strictEqual(f2, '#1–#5 (5 wallets)');

  const f3 = formatWalletNumbers([], 10);
  assert.strictEqual(f3, 'None (Free Mints Only)');

  const f4 = formatWalletNumbers([0, 1, 2], 3);
  assert.strictEqual(f4, 'All (3 Wallets)');
});

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

if (failedTests > 0) {
  process.exit(1);
}
