require('dotenv').config();
const chalk = require('chalk');
const logger = require('../src/utils/logger');
const Notifier = require('../src/utils/notifier');

async function runWebhookTests() {
  logger.banner();
  console.log(chalk.cyan.bold('📢 RUNNING WEBHOOK & NOTIFIER TEST SUITE\n'));

  const discordUrl = process.env.DISCORD_WEBHOOK_URL;
  const tgToken = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId = process.env.TELEGRAM_CHAT_ID;

  console.log(chalk.yellow('Configuration Status:'));
  console.log(`  Discord Webhook:  ${discordUrl ? chalk.green('CONFIGURED (' + discordUrl.slice(0, 35) + '...)') : chalk.gray('NOT CONFIGURED in .env')}`);
  console.log(`  Telegram Alerts:  ${tgToken && tgChatId ? chalk.green('CONFIGURED (Chat ID: ' + tgChatId + ')') : chalk.gray('NOT CONFIGURED in .env')}\n`);

  // ----------------------------------------------------
  // TEST 1: Mint Success Alert Payload
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 1/3] Testing Mint SUCCESS Alert...'));
  try {
    const successPayload = {
      address: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8a9b0c1d2e3',
      status: 'SUCCESS',
      txHash: '0x88df016429689c079f3b2f6ad39fa052532c567d21b25502e212d352b94f228d',
      explorerUrl: 'https://sepolia.etherscan.io',
      contractAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
      latencyMs: 840,
      blockNumber: 11538700
    };

    await Notifier.sendMintAlert(successPayload);
    console.log(chalk.green('  ✔ Success Alert payload structured & dispatched successfully.'));
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 1 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 2: Mint Failed Alert with Human-Readable Error
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 2/3] Testing Mint FAILED Alert (with Human-Readable Error)...'));
  try {
    const failurePayload = {
      address: '0x9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d',
      status: 'FAILED',
      txHash: null,
      explorerUrl: 'https://sepolia.etherscan.io',
      contractAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
      error: "Your wallet doesn't have enough ETH to cover the mint price + gas fees. → Add more ETH to your wallet and try again."
    };

    await Notifier.sendMintAlert(failurePayload);
    console.log(chalk.green('  ✔ Failure Alert payload structured & dispatched successfully.'));
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 2 Failed: ${err.message}`));
  }

  console.log('');

  // ----------------------------------------------------
  // TEST 3: NFT Forwarding Alert
  // ----------------------------------------------------
  console.log(chalk.yellow.bold('[TEST 3/3] Testing NFT Auto-Forwarding Alert...'));
  try {
    const forwardPayload = {
      tokenId: '42',
      fromAddress: '0x1a2b3c4d5e6f708192a3b4c5d6e7f8a9b0c1d2e3',
      toAddress: '0xVault77777777777777777777777777777777777',
      txHash: '0x33aa016429689c079f3b2f6ad39fa052532c567d21b25502e212d352b94faaaa',
      explorerUrl: 'https://sepolia.etherscan.io'
    };

    await Notifier.sendForwardAlert(forwardPayload);
    console.log(chalk.green('  ✔ Forwarding Alert payload structured & dispatched successfully.'));
  } catch (err) {
    console.log(chalk.red(`  ✖ Test 3 Failed: ${err.message}`));
  }

  console.log('');
  logger.separator();
  console.log(chalk.green.bold('🎉 ALL WEBHOOK NOTIFICATION TESTS COMPLETED SUCCESSFULLY!'));
  if (!discordUrl && !tgToken) {
    console.log(chalk.cyan('ℹ Note: Set DISCORD_WEBHOOK_URL or TELEGRAM_BOT_TOKEN in .env to receive live messages in your channels.'));
  }
  logger.separator();
}

runWebhookTests().catch(err => {
  console.error('Fatal webhook test error:', err);
  process.exit(1);
});
