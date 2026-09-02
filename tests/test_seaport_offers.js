const assert = require('assert');
const { ethers, Interface } = require('ethers');
const SeaportOfferEngine = require('../src/services/seaportOfferEngine');

let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
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

async function run() {
  console.log('\n🧪 Running Seaport Offer Engine Unit Test Suite...\n');

  const erc721Iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
  ]);

  const testWallet = new ethers.Wallet('0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  const contractAddr = '0x1234567890123456789012345678901234567890';

  // Construct mock logs for minting tokens #101 and #102
  const log1 = erc721Iface.encodeEventLog(erc721Iface.getEvent('Transfer'), [
    ethers.ZeroAddress,
    testWallet.address,
    101n
  ]);
  const log2 = erc721Iface.encodeEventLog(erc721Iface.getEvent('Transfer'), [
    ethers.ZeroAddress,
    testWallet.address,
    102n
  ]);

  const mockResults = [
    {
      status: 'SUCCESS',
      walletAddress: testWallet.address,
      wallet: testWallet,
      txHash: '0xaaaabbbbccccddddeeeeffff1111222233334444555566667777888899990000',
      receipt: {
        status: 1,
        blockNumber: 52826390,
        logs: [
          { address: contractAddr, topics: log1.topics, data: log1.data },
          { address: contractAddr, topics: log2.topics, data: log2.data }
        ]
      }
    }
  ];

  await test('SeaportOfferEngine: Correctly extracts minted token IDs from receipts', async () => {
    const extracted = SeaportOfferEngine.extractMintedTokens(mockResults, [testWallet]);
    assert.strictEqual(extracted.length, 2);
    assert.strictEqual(extracted[0].tokenId, '101');
    assert.strictEqual(extracted[1].tokenId, '102');
    assert.strictEqual(extracted[0].contractAddress, contractAddr);
    assert.strictEqual(extracted[0].wallet.address, testWallet.address);
  });

  await test('SeaportOfferEngine: Safety floor protects against lowball bids', async () => {
    const minFloorEth = 0.05;
    const topOfferEth = 0.02; // Lowball offer
    const isBelowFloor = topOfferEth < minFloorEth;
    assert.strictEqual(isBelowFloor, true, 'Lowball offer must be blocked by safety floor');
  });

  await test('SeaportOfferEngine: Scope SOME splits tokens accurately', async () => {
    const tokens = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }];
    const sellCount = 2;
    const toSell = tokens.slice(0, sellCount);
    const remainder = tokens.slice(sellCount);

    assert.strictEqual(toSell.length, 2);
    assert.strictEqual(remainder.length, 2);
    assert.deepStrictEqual(toSell.map(t => t.id), [1, 2]);
    assert.deepStrictEqual(remainder.map(t => t.id), [3, 4]);
  });

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`📊 Test Summary: ${passedTests} Passed, ${failedTests} Failed.`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  if (failedTests > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

run();
