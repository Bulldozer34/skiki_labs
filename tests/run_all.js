/**
 * Unified Test Runner for all test suites.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const testFiles = [
  'test_copymint.js',
  'test_copymint_pnl.js',
  'test_wallet_selector.js',
  'test_infra_improvements.js'
];

let failed = false;

for (const file of testFiles) {
  const fullPath = path.join(__dirname, file);
  console.log(`\n==================================================`);
  console.log(`▶ Running Suite: ${file}`);
  console.log(`==================================================`);

  const result = spawnSync('node', [fullPath], { stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    failed = true;
    console.error(`❌ Suite ${file} failed with exit code ${result.status}`);
  }
}

if (failed) {
  console.error('\n❌ One or more test suites failed.');
  process.exit(1);
} else {
  console.log('\n🎉 ALL TEST SUITES PASSED SUCCESSFULLY!');
}
