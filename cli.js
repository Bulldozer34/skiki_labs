#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const inquirer = require('inquirer');
const { ethers } = require('ethers');
const logger = require('./src/utils/logger');
const { CHAINS, getChainChoices, expandAlchemyKey } = require('./src/utils/chains');
const { buildEndpoints } = require('./src/utils/rpcPool');
const { resolveCollection } = require('./src/utils/resolver');
const WalletService = require('./src/services/walletService');
const CollectionService = require('./src/services/collectionService');
const authService = require('./src/services/authService');
const Scheduler = require('./src/scheduler');
const connectionManager = require('./src/services/connectionManager');
const { runPublicMint } = require('./src/engines/publicMintEngine');
const { runAllowlistMint } = require('./src/engines/allowlistMintEngine');
const { checkAllWallets } = require('./src/engines/eligibilityChecker');
const { getEthPriceUsd, convertUsdToEth, convertEthToUsd } = require('./src/utils/priceFetcher');
const { resolveGasPreset } = require('./src/utils/gasPresets');
const TrackerEngine = require('./src/engines/trackerEngine');
const CopyMintEngine = require('./src/engines/copyMintEngine');
const trackedWalletService = require('./src/services/trackedWalletService');

async function main() {
  console.clear();
  logger.banner();

  try {
    // ---------------------------------------------------------
    // STEP 1: Select Minting Mode
    // ---------------------------------------------------------
    const { mintMode } = await inquirer.prompt([
      {
        type: 'list',
        name: 'mintMode',
        message: 'Select Operation Mode:',
        choices: [
          {
            name: '⚡ OpenSea Allowlist / FCFS (Signed Mint via GraphQL)',
            value: 'ALLOWLIST'
          },
          {
            name: '🌊 Public Mint (Direct SeaDrop Contract - No OpenSea Auth Needed)',
            value: 'PUBLIC'
          },
          {
            name: '🐋 Copy-Mint Engine & Whale Tracker (Mempool & Block Automint)',
            value: 'COPYMINT'
          },
          {
            name: '💰 Check Wallet Balances & Nonces',
            value: 'BALANCE'
          },
          {
            name: '🔑 Bulk Wallet Generator (Burner Creation & Funding)',
            value: 'GENERATE'
          }
        ]
      }
    ]);

    if (mintMode === 'COPYMINT') {
      return await copyMintWizardMode();
    }
    if (mintMode === 'BALANCE') {
      return await checkBalancesMode();
    }
    if (mintMode === 'GENERATE') {
      return await generateWalletsMode();
    }

    // ---------------------------------------------------------
    // STEP 2: Select Chain & RPC
    // ---------------------------------------------------------
    const chainChoices = getChainChoices();
    chainChoices.push({ name: '🔧 Custom EVM RPC Endpoint', value: 'CUSTOM' });

    const { selectedChain } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedChain',
        message: 'Select Chain:',
        choices: chainChoices
      }
    ]);

    let rpcUrl = '';
    let chainConfig = selectedChain;

    if (selectedChain === 'CUSTOM') {
      const { customRpc, customChainId } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customRpc',
          message: 'Enter RPC URL (or Alchemy API Key):',
          validate: input => (input.trim().length > 0 ? true : 'RPC URL is required')
        },
        {
          type: 'number',
          name: 'customChainId',
          message: 'Enter Chain ID:',
          default: 8453
        }
      ]);

      rpcUrl = customRpc.trim();
      chainConfig = {
        name: 'Custom',
        chainId: customChainId,
        defaultRpc: rpcUrl
      };
    } else {
      const defaultChainRpc = selectedChain.alchemyPrefix && process.env.ALCHEMY_KEY
        ? expandAlchemyKey(process.env.ALCHEMY_KEY, selectedChain)
        : (selectedChain.defaultRpc || process.env.DEFAULT_RPC_URL);

      const { rpcInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'rpcInput',
          message: `RPC Endpoint for ${selectedChain.name} (Press Enter to use default):`,
          default: defaultChainRpc
        }
      ]);

      rpcUrl = expandAlchemyKey(rpcInput.trim(), selectedChain);
    }

    logger.info(`Connecting to RPC: ${rpcUrl}`);
    const provider = connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId);

    // Verify RPC Connection
    try {
      const net = await provider.getNetwork();
      logger.success(`Connected to network (Chain ID: ${net.chainId})`);
    } catch (rpcErr) {
      logger.error(`Could not connect to RPC: ${rpcErr.message}`);
      process.exit(1);
    }

    // ---------------------------------------------------------
    // STEP 3: Private Keys Input (Runtime Paste)
    // ---------------------------------------------------------
    logger.separator();
    const wallets = await WalletService.promptWalletKeys();

    if (wallets.length === 0) {
      logger.error('At least one private key is required to mint. Exiting.');
      process.exit(1);
    }

    // Pre-check balances
    await WalletService.checkBalances(wallets, provider);

    // ---------------------------------------------------------
    // STEP 4: NFT Recipient Forwarding Address
    // ---------------------------------------------------------
    logger.separator();
    const envRecipient = (process.env.RECIPIENT_ADDRESS || '').trim();
    const recipientPromptConfig = {
      type: 'input',
      name: 'recipientInput',
      message: 'Recipient address to forward minted NFTs to (Press Enter to keep in minting wallets):',
      validate: input => {
        if (!input || !input.trim() || input.trim() === 'undefined' || input.trim().toLowerCase() === 'none') {
          return true;
        }
        return ethers.isAddress(input.trim()) ? true : 'Invalid Ethereum address (must start with 0x)';
      }
    };

    if (envRecipient && ethers.isAddress(envRecipient)) {
      recipientPromptConfig.default = envRecipient;
    }

    const { recipientInput } = await inquirer.prompt([recipientPromptConfig]);
    const rawRecipient = (recipientInput || '').trim();
    const recipientAddress = (rawRecipient && rawRecipient !== 'undefined' && rawRecipient.toLowerCase() !== 'none' && ethers.isAddress(rawRecipient))
      ? ethers.getAddress(rawRecipient)
      : null;

    if (recipientAddress) {
      logger.success(`NFTs will be automatically forwarded to: ${recipientAddress}`);
    } else {
      logger.info('NFTs will remain in their respective minting wallets.');
    }

    // ---------------------------------------------------------
    // STEP 5: Collection Identifier (URL / Slug / Contract)
    // ---------------------------------------------------------
    logger.separator();
    const defaultDemoContract = chainConfig.seadropAddress || '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5';
    const { collectionInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'collectionInput',
        message: 'OpenSea Collection URL, Slug, or Contract Address (or type "demo" for test):',
        default: 'demo',
        validate: input => {
          if (!input || !input.trim() || input.trim().toLowerCase() === 'demo' || input.trim().toLowerCase() === 'test') {
            return true;
          }
          return input.trim().length > 0 ? true : 'Collection identifier is required';
        }
      }
    ]);

    const cleanInput = (collectionInput || 'demo').trim();
    let nftContractAddress = null;
    let collectionSlug = null;

    if (cleanInput.toLowerCase() === 'demo' || cleanInput.toLowerCase() === 'test' || cleanInput === '') {
      logger.info(`🧪 Using Demo Test Contract: ${defaultDemoContract}`);
      nftContractAddress = defaultDemoContract;
      collectionSlug = 'demo-testnet-drop';
    } else {
      const resolved = resolveCollection(cleanInput);
      nftContractAddress = resolved.address;
      collectionSlug = resolved.slug;

      // If slug provided but no contract address, attempt to resolve contract from slug
      if (!nftContractAddress && collectionSlug) {
        logger.info(`Resolving contract address for slug: "${collectionSlug}"...`);
        nftContractAddress = await CollectionService.getContractFromSlug(collectionSlug);
        if (nftContractAddress) {
          logger.success(`Resolved Contract: ${nftContractAddress}`);
        } else {
          // Prompt for contract if slug couldn't be auto-resolved
          const { manualContract } = await inquirer.prompt([
            {
              type: 'input',
              name: 'manualContract',
              message: 'Could not auto-resolve contract address from slug. Please enter 0x contract address directly:',
              default: defaultDemoContract,
              validate: input => (ethers.isAddress(input.trim()) ? true : 'Invalid contract address')
            }
          ]);
          nftContractAddress = manualContract.trim();
        }
      }
    }

    // ---------------------------------------------------------
    // STEP 6: Mint Quantity
    // ---------------------------------------------------------
    const { quantity } = await inquirer.prompt([
      {
        type: 'number',
        name: 'quantity',
        message: 'NFT Quantity per Wallet:',
        default: 1,
        validate: val => (val > 0 ? true : 'Quantity must be greater than 0')
      }
    ]);

    // ---------------------------------------------------------
    // STEP 7: Gas Configuration (Auto-Optimized — Zero Friction)
    // ---------------------------------------------------------
    logger.separator();
    const isL2 = chainConfig.chainId !== 1; // Robinhood, Base, Arbitrum, Optimism, etc.
    let liveBaseFeeGwei = isL2 ? '0.04' : '25.0';
    try {
      const feeData = await provider.getFeeData();
      if (feeData.maxFeePerGas) {
        liveBaseFeeGwei = ethers.formatUnits(feeData.maxFeePerGas, 'gwei');
      }
    } catch (e) {}

    // Auto-resolve optimal gas profile for the target chain
    const defaultPreset = isL2 ? 'turbo' : 'ultra';
    const gasSettings = resolveGasPreset(defaultPreset, { isL2, liveBaseFeeGwei });
    logger.speed(`⚡ Gas Profile: Auto-Optimized for ${chainConfig.name} (Max Fee: ${gasSettings.maxFeePerGas} Gwei | Priority Tip: ${gasSettings.maxPriorityFeePerGas} Gwei)`);

    // ---------------------------------------------------------
    // STEP 8: Timing & Scheduling
    // ---------------------------------------------------------
    logger.separator();
    const { timingChoice } = await inquirer.prompt([
      {
        type: 'list',
        name: 'timingChoice',
        message: 'Scheduling / Timing:',
        choices: [
          { name: '🚀 Mint Immediately', value: 'NOW' },
          { name: '📡 Auto-Schedule from OpenSea Drop Page (Polls drop time)', value: 'AUTO' },
          { name: '⏰ Specific Start Time (Unix Timestamp or ISO Date)', value: 'CUSTOM_TIME' }
        ]
      }
    ]);

    let startTime = 0;

    if (timingChoice === 'AUTO') {
      if (!collectionSlug) {
        const { askSlug } = await inquirer.prompt([
          {
            type: 'input',
            name: 'askSlug',
            message: 'Enter OpenSea collection slug for drop schedule monitoring:',
            validate: val => (val.trim().length > 0 ? true : 'Slug is required')
          }
        ]);
        collectionSlug = askSlug.trim();
      }

      // Authenticate first wallet to get session for dropBySlug query
      logger.info('Authenticating with OpenSea to read drop schedule...');
      await authService.authenticate(wallets[0]);
      const authHeaders = authService.getAuthHeaders(wallets[0].address);

      try {
        startTime = await Scheduler.autoSchedule(collectionSlug, authHeaders);
      } catch (schedErr) {
        logger.error(`Auto-schedule failed: ${schedErr.message}`);
        const { fallbackChoice } = await inquirer.prompt([
          {
            type: 'list',
            name: 'fallbackChoice',
            message: 'Auto-schedule failed. What would you like to do?',
            choices: [
              { name: '🚀 Mint Immediately (now)', value: 'NOW' },
              { name: '⏱  In 1 minute', value: 60 },
              { name: '⏱  In 5 minutes', value: 300 },
              { name: '❌ Abort', value: 'ABORT' }
            ]
          }
        ]);

        if (fallbackChoice === 'ABORT') {
          logger.warn('Aborted by user.');
          process.exit(0);
        } else if (fallbackChoice === 'NOW') {
          startTime = 0;
        } else {
          startTime = Math.floor(Date.now() / 1000) + fallbackChoice;
          const diffSec = startTime - Math.floor(Date.now() / 1000);
          logger.info(`Fallback scheduled for: ${new Date(startTime * 1000).toLocaleString()} (in ${logger.formatDuration(diffSec)})`);
        }
      }
    } else if (timingChoice === 'CUSTOM_TIME') {
      const { quickPick } = await inquirer.prompt([
        {
          type: 'list',
          name: 'quickPick',
          message: 'Schedule mint for:',
          choices: [
            { name: '⏱  In 1 minute', value: 60 },
            { name: '⏱  In 2 minutes', value: 120 },
            { name: '⏱  In 5 minutes', value: 300 },
            { name: '⏱  In 10 minutes', value: 600 },
            { name: '⏱  In 30 minutes', value: 1800 },
            { name: '✏️  Enter custom time (HH:MM / timestamp / ISO)', value: 'CUSTOM' }
          ]
        }
      ]);

      if (quickPick === 'CUSTOM') {
        const { timeInput } = await inquirer.prompt([
          {
            type: 'input',
            name: 'timeInput',
            message: 'Enter time (HH:MM for today, 10-digit unix timestamp, or ISO date):',
            validate: val => {
              const v = val.trim();
              if (/^\d{10}$/.test(v)) return true;
              if (/^\d{1,2}:\d{2}$/.test(v)) return true;
              if (!isNaN(Date.parse(v))) return true;
              return 'Enter HH:MM (e.g. 14:30), a 10-digit unix timestamp, or an ISO date';
            }
          }
        ]);

        const raw = timeInput.trim();
        if (/^\d{10}$/.test(raw)) {
          startTime = parseInt(raw);
        } else if (/^\d{1,2}:\d{2}$/.test(raw)) {
          // Parse HH:MM as today's date
          const [h, m] = raw.split(':').map(Number);
          const target = new Date();
          target.setHours(h, m, 0, 0);
          // If the time already passed today, assume tomorrow
          if (target.getTime() < Date.now()) {
            target.setDate(target.getDate() + 1);
          }
          startTime = Math.floor(target.getTime() / 1000);
        } else {
          startTime = Math.floor(Date.parse(raw) / 1000);
        }
      } else {
        // Quick offset — add seconds to current time
        startTime = Math.floor(Date.now() / 1000) + quickPick;
      }

      const diffSec = startTime - Math.floor(Date.now() / 1000);
      logger.info(`Scheduled for: ${new Date(startTime * 1000).toLocaleString()} (in ${logger.formatDuration(diffSec)})`);
    }

    // ---------------------------------------------------------
    // STEP 9: Summary & Confirmation
    // ---------------------------------------------------------

    // Build the ordered endpoint pool before the summary so the operator can see
    // which path writes will take. On a FIFO chain the ordering matters: the
    // sequencer's write ingress goes first (it is the only node that can order a
    // transaction — everything else forwards to it) and is tagged broadcast-only
    // so nothing tries to read state through it.
    const { endpoints, urls: rpcUrls, feedUrl } = buildEndpoints(chainConfig, rpcUrl);

    logger.separator();
    console.log(logger.summaryTable ? '' : '');
    logger.info('=== CONFIGURATION SUMMARY ===');
    console.log(`Mode:           ${mintMode}`);
    console.log(`Chain:          ${chainConfig.name} (${chainConfig.chainId || 'EVM'})`);
    console.log(`NFT Contract:   ${nftContractAddress}`);
    console.log(`Wallets:        ${wallets.length} wallet(s) loaded`);
    console.log(`Quantity/Wallet:${quantity} (Total: ${wallets.length * quantity})`);
    console.log(`Recipient:      ${recipientAddress || 'None (Stay in minting wallets)'}`);
    console.log(`Max Fee:        ${gasSettings.maxFeePerGas} Gwei | Tip: ${gasSettings.maxPriorityFeePerGas} Gwei`);
    console.log(`Write Path:     ${endpoints.map(e => e.label).join(' → ') || 'none'}`);
    console.log(`Sequencer Feed: ${feedUrl || 'disabled (will poll blocks for drop time)'}`);
    const leadTimeDisplay = (process.env.SNIPER_LEAD_TIME_MS || '').trim()
      ? `${process.env.SNIPER_LEAD_TIME_MS}ms (pinned via SNIPER_LEAD_TIME_MS)`
      : 'auto-calibrated from measured latency at T-5s';
    console.log(`Sniper Lead:    ${leadTimeDisplay}`);
    const timeUntilStr = startTime ? ` (in ${logger.formatDuration(startTime - Math.floor(Date.now() / 1000))})` : '';
    console.log(`Start Time:     ${startTime ? new Date(startTime * 1000).toLocaleTimeString() + timeUntilStr : 'Immediate'}`);
    logger.separator();

    const { confirmed } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmed',
        message: 'Ready to arm sniper and execute?',
        default: true
      }
    ]);

    if (!confirmed) {
      logger.warn('Mint aborted by user.');
      process.exit(0);
    }

    const runConfig = {
      wallets,
      provider,
      endpoints,
      rpcUrls,
      feedUrl,
      nftContractAddress,
      collectionSlug,
      chain: chainConfig,
      quantity,
      gasSettings,
      startTime,
      recipientAddress
    };

    if (mintMode === 'PUBLIC') {
      await runPublicMint(runConfig);
    } else {
      await runAllowlistMint(runConfig);
    }

    logger.success('All tasks finished! Have a great day.');
  } catch (err) {
    logger.error(`Execution failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

/**
 * Eligibility Pre-Check Mode (--check flag)
 * Mini wizard: chain, keys, slug → check eligibility → print table → exit
 */
async function checkEligibility() {
  console.clear();
  logger.banner();
  logger.info('🔍 Eligibility Pre-Check Mode');
  logger.separator();

  try {
    // 1. Select Chain & RPC
    const chainChoices = getChainChoices();
    chainChoices.push({ name: '🔧 Custom EVM RPC Endpoint', value: 'CUSTOM' });

    const { selectedChain } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedChain',
        message: 'Select Chain:',
        choices: chainChoices
      }
    ]);

    let rpcUrl = '';
    let chainConfig = selectedChain;

    if (selectedChain === 'CUSTOM') {
      const { customRpc } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customRpc',
          message: 'Enter RPC URL:',
          validate: input => (input.trim().length > 0 ? true : 'RPC URL is required')
        }
      ]);
      rpcUrl = customRpc.trim();
      chainConfig = { name: 'Custom', chainId: 8453, defaultRpc: rpcUrl };
    } else {
      const defaultChainRpc = selectedChain.alchemyPrefix && process.env.ALCHEMY_KEY
        ? expandAlchemyKey(process.env.ALCHEMY_KEY, selectedChain)
        : (selectedChain.defaultRpc || process.env.DEFAULT_RPC_URL);

      const { rpcInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'rpcInput',
          message: `RPC Endpoint for ${selectedChain.name} (Press Enter to use default):`,
          default: defaultChainRpc
        }
      ]);

      rpcUrl = expandAlchemyKey(rpcInput.trim(), selectedChain);
    }

    // 2. Private Keys
    logger.separator();
    const wallets = await WalletService.promptWalletKeys();

    if (wallets.length === 0) {
      logger.error('At least one private key is required. Exiting.');
      process.exit(1);
    }

    // 3. Collection Slug
    logger.separator();
    const { collectionInput } = await inquirer.prompt([
      {
        type: 'input',
        name: 'collectionInput',
        message: 'OpenSea Collection URL, Slug, or Contract Address:',
        validate: input => (input.trim().length > 0 ? true : 'Collection identifier is required')
      }
    ]);

    const resolved = resolveCollection(collectionInput.trim());
    let collectionSlug = resolved.slug;

    if (!collectionSlug) {
      // If user pasted a contract address, use it as the slug fallback
      collectionSlug = resolved.address || collectionInput.trim();
    }

    // 4. Optional: quantity
    const { quantity } = await inquirer.prompt([
      {
        type: 'number',
        name: 'quantity',
        message: 'Quantity to check per wallet:',
        default: 1,
        validate: val => (val > 0 ? true : 'Quantity must be greater than 0')
      }
    ]);

    // 5. Run eligibility check
    await checkAllWallets({
      wallets,
      collectionSlug,
      quantity
    });

    process.exit(0);
  } catch (err) {
    logger.error(`Check failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

/**
 * Wallet Generator Mode (--generate flag)
 * Generates N random Ethereum wallets, displays them, and saves to .txt
 */
async function generateWalletsMode() {
  console.clear();
  logger.banner();
  logger.info('🔑 Wallet Generator Mode');
  logger.separator();

  try {
    // Check if count was passed as CLI arg (e.g. --generate 5)
    const rawArgs = process.argv.slice(2);
    const genIndex = rawArgs.findIndex(a => ['--generate', '-g', 'generate'].includes(a.toLowerCase()));
    let defaultCount = 1;
    if (genIndex >= 0 && rawArgs[genIndex + 1] && /^\d+$/.test(rawArgs[genIndex + 1])) {
      defaultCount = parseInt(rawArgs[genIndex + 1]);
    }

    const { count } = await inquirer.prompt([
      {
        type: 'number',
        name: 'count',
        message: 'How many wallets to generate?',
        default: defaultCount,
        validate: val => (val > 0 && val <= 100 ? true : 'Enter a number between 1 and 100')
      }
    ]);

    logger.info(`Generating ${count} wallet(s)...`);
    const { entries } = WalletService.generateWallets(count);

    // Display table
    const chalk = require('chalk');
    const Table = require('cli-table3');
    const table = new Table({
      head: [
        chalk.white.bold('#'),
        chalk.white.bold('Address'),
        chalk.white.bold('Private Key')
      ],
      colWidths: [5, 46, 70],
      style: { head: [], border: [] }
    });

    for (const e of entries) {
      table.push([e.index, e.address, e.privateKey]);
    }

    console.log('');
    console.log(table.toString());
    console.log('');

    // Save to file
    const savedPath = WalletService.saveWalletsToFile(entries);
    logger.success(`Saved to: ${savedPath}`);
    logger.warn('⚠️  Back up this file immediately. Lost keys = lost wallets forever.');
    logger.separator();

    // Show addresses-only summary for easy copying
    logger.info('Addresses (for funding):');
    for (const e of entries) {
      console.log(`  ${e.address}`);
    }
    logger.separator();

    // Ask if user wants to auto-fund these wallets from a master wallet
    const { shouldFund } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'shouldFund',
        message: 'Would you like to auto-fund these generated wallets from a master wallet now?',
        default: false
      }
    ]);

    if (shouldFund) {
      logger.separator();
      logger.info('💰 Auto-Funding Setup');

      // 1. Select Chain & RPC
      const chainChoices = getChainChoices();
      chainChoices.push({ name: '🔧 Custom EVM RPC Endpoint', value: 'CUSTOM' });

      const { fundChain } = await inquirer.prompt([
        {
          type: 'list',
          name: 'fundChain',
          message: 'Select Chain to fund on:',
          choices: chainChoices
        }
      ]);

      let rpcUrl = '';
      let chainConfig = fundChain;

      if (fundChain === 'CUSTOM') {
        const { customRpc, customChainId } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customRpc',
            message: 'Enter RPC URL:',
            validate: input => (input.trim().length > 0 ? true : 'RPC URL is required')
          },
          {
            type: 'number',
            name: 'customChainId',
            message: 'Enter Chain ID:',
            default: 1
          }
        ]);
        rpcUrl = customRpc.trim();
        chainConfig = { name: 'Custom', chainId: customChainId, defaultRpc: rpcUrl };
      } else {
        const defaultChainRpc = fundChain.alchemyPrefix && process.env.ALCHEMY_KEY
          ? expandAlchemyKey(process.env.ALCHEMY_KEY, fundChain)
          : (fundChain.defaultRpc || process.env.DEFAULT_RPC_URL);

        const { rpcInput } = await inquirer.prompt([
          {
            type: 'input',
            name: 'rpcInput',
            message: `RPC Endpoint for ${fundChain.name} (Press Enter to use default):`,
            default: defaultChainRpc
          }
        ]);
        rpcUrl = expandAlchemyKey(rpcInput.trim(), fundChain);
      }

      logger.info(`Connecting to RPC: ${rpcUrl}`);
      const provider = connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId);

      try {
        const net = await provider.getNetwork();
        logger.success(`Connected to ${chainConfig.name} (Chain ID: ${net.chainId})`);
      } catch (rpcErr) {
        logger.error(`Could not connect to RPC: ${rpcErr.message}`);
        process.exit(1);
      }

      // 2. Master Wallet Private Key
      logger.separator();
      const { masterPk } = await inquirer.prompt([
        {
          type: 'password',
          name: 'masterPk',
          message: 'Enter Master / Funding Wallet Private Key:',
          mask: '*',
          validate: input => {
            let key = input.trim();
            if (!key.startsWith('0x')) key = '0x' + key;
            try {
              new ethers.Wallet(key);
              return true;
            } catch (e) {
              return 'Invalid private key format';
            }
          }
        }
      ]);

      let cleanMasterKey = masterPk.trim();
      if (!cleanMasterKey.startsWith('0x')) cleanMasterKey = '0x' + cleanMasterKey;
      const masterWallet = new ethers.Wallet(cleanMasterKey);
      logger.success(`Master Wallet: ${masterWallet.address}`);

      // Check Master Balance
      const masterBalanceWei = await provider.getBalance(masterWallet.address);
      const masterBalanceEth = ethers.formatEther(masterBalanceWei);
      logger.info(`Master Wallet Balance: ${masterBalanceEth} ETH`);

      if (masterBalanceWei === 0n) {
        logger.error('Master wallet has 0 ETH balance. Cannot fund wallets.');
        process.exit(1);
      }

      // 3. Fetch Live ETH Price in USD
      logger.separator();
      logger.info('Fetching live ETH price...');
      const ethPriceUsd = await getEthPriceUsd();
      if (ethPriceUsd) {
        logger.info(`Live ETH Price: $${ethPriceUsd.toLocaleString()} USD`);
      } else {
        logger.warn('Could not fetch live ETH price from price APIs.');
      }

      // 4. Prompt for Funding Amount (USD or ETH)
      const { inputMode } = await inquirer.prompt([
        {
          type: 'list',
          name: 'inputMode',
          message: 'How would you like to specify the funding amount per wallet?',
          choices: ethPriceUsd ? [
            { name: `💵 In USD ($) — Converted using live price ($${ethPriceUsd}/ETH)`, value: 'USD' },
            { name: '💎 In ETH (e.g. 0.005 ETH)', value: 'ETH' }
          ] : [
            { name: '💎 In ETH (e.g. 0.005 ETH)', value: 'ETH' },
            { name: '💵 In USD ($)', value: 'USD' }
          ]
        }
      ]);

      let amountEthEach = '0';

      if (inputMode === 'USD') {
        let priceToUse = ethPriceUsd;
        if (!priceToUse) {
          const { manualPrice } = await inquirer.prompt([
            {
              type: 'number',
              name: 'manualPrice',
              message: 'Enter current ETH price in USD (e.g. 2500):',
              default: 2500,
              validate: v => (v > 0 ? true : 'Price must be > 0')
            }
          ]);
          priceToUse = manualPrice;
        }

        const { usdInput } = await inquirer.prompt([
          {
            type: 'number',
            name: 'usdInput',
            message: 'How much USD ($) to fund each wallet?',
            default: 10,
            validate: v => (v > 0 ? true : 'Amount must be > 0')
          }
        ]);

        amountEthEach = convertUsdToEth(usdInput, priceToUse);
        logger.info(`$${usdInput} USD per wallet = ~${amountEthEach} ETH per wallet (at $${priceToUse}/ETH)`);
      } else {
        const { ethInput } = await inquirer.prompt([
          {
            type: 'input',
            name: 'ethInput',
            message: 'How much ETH to fund each wallet (e.g. 0.01)?',
            default: '0.005',
            validate: v => {
              try {
                const p = ethers.parseEther(v.trim());
                return p > 0n ? true : 'Must be > 0';
              } catch (e) {
                return 'Invalid ETH amount';
              }
            }
          }
        ]);

        amountEthEach = ethInput.trim();
        if (ethPriceUsd) {
          const amountUsdEach = convertEthToUsd(amountEthEach, ethPriceUsd);
          logger.info(`${amountEthEach} ETH per wallet = ~$${amountUsdEach} USD (at $${ethPriceUsd}/ETH)`);
        }
      }

      const amountWeiEach = ethers.parseEther(amountEthEach);
      const totalAmountWei = amountWeiEach * BigInt(entries.length);
      const totalAmountEth = ethers.formatEther(totalAmountWei);
      const totalAmountUsd = ethPriceUsd ? (parseFloat(amountEthEach) * entries.length * ethPriceUsd).toFixed(2) : null;

      // Estimate gas for transfers (21000 gas per standard transfer)
      const isL2 = chainConfig.chainId !== 1;
      const feeData = await provider.getFeeData().catch(() => ({}));
      const maxFeePerGas = feeData.maxFeePerGas || (isL2 ? ethers.parseUnits('0.1', 'gwei') : ethers.parseUnits('25', 'gwei'));
      const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || (isL2 ? ethers.parseUnits('0.01', 'gwei') : ethers.parseUnits('1.5', 'gwei'));
      const gasPerTransfer = 21000n;
      const totalGasCostWei = maxFeePerGas * gasPerTransfer * BigInt(entries.length);
      const totalRequiredWei = totalAmountWei + totalGasCostWei;
      const totalRequiredEth = ethers.formatEther(totalRequiredWei);

      logger.separator();
      logger.info('=== FUNDING BREAKDOWN ===');
      console.log(`Wallets to fund:      ${entries.length}`);
      console.log(`Amount per wallet:    ${amountEthEach} ETH ${ethPriceUsd ? `(~$${(parseFloat(amountEthEach) * ethPriceUsd).toFixed(2)})` : ''}`);
      console.log(`Total Transfer Amount:${totalAmountEth} ETH ${totalAmountUsd ? `(~$${totalAmountUsd})` : ''}`);
      console.log(`Est. Total Gas Fees:  ~${ethers.formatEther(totalGasCostWei)} ETH (${entries.length} txs)`);
      console.log(`Total Needed:         ~${totalRequiredEth} ETH`);
      console.log(`Master Balance:       ${masterBalanceEth} ETH`);
      logger.separator();

      if (masterBalanceWei < totalRequiredWei) {
        logger.error(`Insufficient Master Balance! Needed ~${totalRequiredEth} ETH, but master only has ${masterBalanceEth} ETH.`);
        process.exit(1);
      }

      const { confirmFund } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirmFund',
          message: `Send ~${totalAmountEth} ETH total to ${entries.length} wallet(s)?`,
          default: true
        }
      ]);

      if (!confirmFund) {
        logger.warn('Auto-funding aborted by user.');
        process.exit(0);
      }

      // Execute transfers
      logger.separator();
      logger.speed(`>>> Executing ${entries.length} funding transaction(s)... <<<`);
      const recipientAddresses = entries.map(e => e.address);
      const gasFees = { maxFeePerGas, maxPriorityFeePerGas };
      
      const fundResults = await WalletService.fundWallets(
        masterWallet,
        recipientAddresses,
        amountWeiEach,
        provider,
        gasFees
      );

      // Print Summary Table
      logger.separator();
      logger.info('=== FUNDING RESULTS ===');
      const fundTable = new Table({
        head: [
          chalk.white.bold('#'),
          chalk.white.bold('Address'),
          chalk.white.bold('Amount (ETH)'),
          chalk.white.bold('Status'),
          chalk.white.bold('Tx Hash / Error')
        ],
        colWidths: [5, 46, 16, 12, 40],
        style: { head: [], border: [] }
      });

      let successCount = 0;
      fundResults.forEach((r, idx) => {
        const isSuccess = r.status === 'SUCCESS';
        if (isSuccess) successCount++;
        fundTable.push([
          idx + 1,
          r.address,
          amountEthEach,
          isSuccess ? chalk.green('SUCCESS') : chalk.red('FAILED'),
          r.txHash ? `${r.txHash.slice(0, 18)}...` : (r.error || 'N/A')
        ]);
      });

      console.log(fundTable.toString());
      logger.separator();
      logger.success(`Successfully funded ${successCount}/${entries.length} wallet(s)!`);
    }

    process.exit(0);
  } catch (err) {
    logger.error(`Generation failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

/**
 * Balance Checker Mode (--balance flag)
 * Checks live ETH balance, USD value, and Nonce for any wallet(s) across any chain
 */
async function checkBalancesMode() {
  console.clear();
  logger.banner();
  logger.info('💰 Wallet Balance & Nonce Checker');
  logger.separator();

  try {
    // 1. Select Chain & RPC
    const chainChoices = getChainChoices();
    chainChoices.push({ name: '🔧 Custom EVM RPC Endpoint', value: 'CUSTOM' });

    const { selectedChain } = await inquirer.prompt([
      {
        type: 'list',
        name: 'selectedChain',
        message: 'Select Chain to check balances on:',
        choices: chainChoices
      }
    ]);

    let rpcUrl = '';
    let chainConfig = selectedChain;

    if (selectedChain === 'CUSTOM') {
      const { customRpc, customChainId } = await inquirer.prompt([
        {
          type: 'input',
          name: 'customRpc',
          message: 'Enter RPC URL:',
          validate: input => (input.trim().length > 0 ? true : 'RPC URL is required')
        },
        {
          type: 'number',
          name: 'customChainId',
          message: 'Enter Chain ID:',
          default: 1
        }
      ]);

      rpcUrl = customRpc.trim();
      chainConfig = {
        name: 'Custom',
        chainId: customChainId,
        defaultRpc: rpcUrl
      };
    } else {
      const defaultChainRpc = selectedChain.alchemyPrefix && process.env.ALCHEMY_KEY
        ? expandAlchemyKey(process.env.ALCHEMY_KEY, selectedChain)
        : (selectedChain.defaultRpc || process.env.DEFAULT_RPC_URL);

      const { rpcInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'rpcInput',
          message: `RPC Endpoint for ${selectedChain.name} (Press Enter for default):`,
          default: defaultChainRpc
        }
      ]);

      rpcUrl = expandAlchemyKey(rpcInput.trim(), selectedChain);
    }

    logger.info(`Connecting to RPC: ${rpcUrl}`);
    const provider = connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId);

    try {
      const net = await provider.getNetwork();
      logger.success(`Connected to network (Chain ID: ${net.chainId})`);
    } catch (rpcErr) {
      logger.error(`Could not connect to RPC: ${rpcErr.message}`);
      process.exit(1);
    }

    // 2. Select Address Input Method
    logger.separator();
    const { inputMethod } = await inquirer.prompt([
      {
        type: 'list',
        name: 'inputMethod',
        message: 'How would you like to provide wallets to check?',
        choices: [
          { name: '📄 Load from .txt file (wallets.txt / wallets_*.txt)', value: 'FILE' },
          { name: '📋 Paste private keys or 0x addresses manually', value: 'PASTE' }
        ]
      }
    ]);

    let targetAddresses = [];

    if (inputMethod === 'FILE') {
      const files = fs.readdirSync(process.cwd()).filter(f => f.endsWith('.txt') || f.endsWith('.csv'));
      const fileChoices = files.map(f => ({ name: f, value: f }));
      fileChoices.push({ name: '✏️  Enter custom path...', value: 'CUSTOM' });

      const { chosenFile } = await inquirer.prompt([
        {
          type: 'list',
          name: 'chosenFile',
          message: 'Select file to load addresses/keys from:',
          choices: fileChoices
        }
      ]);

      let targetPath = chosenFile;
      if (chosenFile === 'CUSTOM') {
        const { customPath } = await inquirer.prompt([
          {
            type: 'input',
            name: 'customPath',
            message: 'Enter file path:',
            validate: input => fs.existsSync(input.trim()) ? true : 'File does not exist'
          }
        ]);
        targetPath = customPath.trim();
      }

      targetAddresses = WalletService.loadAddressesFromFile(targetPath);
    } else {
      const { pastedAddresses } = await inquirer.prompt([
        {
          type: 'input',
          name: 'pastedAddresses',
          message: 'Enter 0x addresses or private keys (separated by comma or space):',
          validate: input => input.trim().length > 0 ? true : 'At least one address or key is required'
        }
      ]);

      const lines = pastedAddresses.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
      for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('//')) continue;
        let clean = line.startsWith('0x') ? line : '0x' + line;
        try {
          if (clean.length === 42 && ethers.isAddress(clean)) {
            const addr = ethers.getAddress(clean);
            if (!targetAddresses.includes(addr)) targetAddresses.push(addr);
          } else {
            const w = new ethers.Wallet(clean);
            if (!targetAddresses.includes(w.address)) targetAddresses.push(w.address);
          }
        } catch (e) {}
      }
    }

    if (targetAddresses.length === 0) {
      logger.error('No valid Ethereum addresses or keys provided. Exiting.');
      process.exit(1);
    }

    logger.info(`Fetching balances and nonces for ${targetAddresses.length} wallet(s)...`);

    // Fetch live ETH USD price
    let ethPriceUsd = 0;
    try {
      ethPriceUsd = await getEthPriceUsd();
    } catch (e) {}

    const results = await WalletService.checkDetailedBalances(targetAddresses, provider, ethPriceUsd);

    // Display formatted table
    const chalk = require('chalk');
    const Table = require('cli-table3');
    const table = new Table({
      head: [
        chalk.white.bold('#'),
        chalk.white.bold('Address'),
        chalk.white.bold('ETH Balance'),
        chalk.white.bold('USD Value'),
        chalk.white.bold('Nonce (Tx Count)'),
        chalk.white.bold('Status')
      ],
      colWidths: [5, 46, 18, 14, 18, 18],
      style: { head: [], border: [] }
    });

    let totalWei = 0n;
    let lowBalanceCount = 0;

    results.forEach((r, idx) => {
      totalWei += r.balanceWei;
      const isZero = r.balanceWei === 0n;
      const isLow = r.balanceWei < ethers.parseEther('0.0005');
      if (isLow) lowBalanceCount++;

      let statusStr = chalk.green('🟢 Ready');
      if (isZero) {
        statusStr = chalk.red('🔴 Empty (0)');
      } else if (isLow) {
        statusStr = chalk.yellow('🟡 Low (<0.0005)');
      }

      table.push([
        idx + 1,
        r.address,
        `${parseFloat(r.balanceEth).toFixed(6)} ETH`,
        ethPriceUsd > 0 ? `$${r.balanceUsd}` : '—',
        r.nonce.toString(),
        statusStr
      ]);
    });

    console.log('');
    console.log(table.toString());
    console.log('');

    const totalEth = ethers.formatEther(totalWei);
    const totalUsd = ethPriceUsd > 0 ? (parseFloat(totalEth) * ethPriceUsd).toFixed(2) : '0.00';

    logger.separator();
    logger.info(`📊 Portfolio Summary:`);
    console.log(`  Total Wallets:  ${results.length}`);
    console.log(`  Total Balance:  ${parseFloat(totalEth).toFixed(6)} ETH ${ethPriceUsd > 0 ? `(~$${totalUsd} USD)` : ''}`);
    console.log(`  Funded Wallets: ${results.length - lowBalanceCount} / ${results.length}`);
    if (lowBalanceCount > 0) {
      logger.warn(`  ⚠️  ${lowBalanceCount} wallet(s) have low or zero balance.`);
    }
    logger.separator();

    // Option to auto-fund low wallets
    if (lowBalanceCount > 0) {
      const { promptAutoFund } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'promptAutoFund',
          message: 'Would you like to auto-fund the low-balance wallets from a master wallet now?',
          default: false
        }
      ]);

      if (promptAutoFund) {
        const lowAddresses = results.filter(r => r.balanceWei < ethers.parseEther('0.0005')).map(r => r.address);
        
        const { masterPrivateKey, fundAmountEth } = await inquirer.prompt([
          {
            type: 'password',
            name: 'masterPrivateKey',
            message: 'Enter Master Wallet Private Key:',
            validate: input => {
              let k = input.trim();
              if (!k.startsWith('0x')) k = '0x' + k;
              try {
                new ethers.Wallet(k);
                return true;
              } catch (e) {
                return 'Invalid private key';
              }
            }
          },
          {
            type: 'input',
            name: 'fundAmountEth',
            message: 'Amount of ETH to send to EACH low-balance wallet:',
            default: '0.001',
            validate: input => (!isNaN(parseFloat(input)) && parseFloat(input) > 0 ? true : 'Invalid ETH amount')
          }
        ]);

        let cleanMasterKey = masterPrivateKey.trim();
        if (!cleanMasterKey.startsWith('0x')) cleanMasterKey = '0x' + cleanMasterKey;
        const masterWallet = new ethers.Wallet(cleanMasterKey, provider);

        const amountWeiEach = ethers.parseEther(fundAmountEth.trim());
        const totalNeededWei = amountWeiEach * BigInt(lowAddresses.length);
        const masterBalance = await provider.getBalance(masterWallet.address);

        if (masterBalance < totalNeededWei) {
          logger.error(`Master wallet has insufficient funds (Balance: ${ethers.formatEther(masterBalance)} ETH, Required: ${ethers.formatEther(totalNeededWei)} ETH)`);
          process.exit(1);
        }

        const fundResults = await WalletService.fundWallets(masterWallet, lowAddresses, amountWeiEach, provider);
        const fundSuccess = fundResults.filter(r => r.status === 'SUCCESS').length;
        logger.success(`Auto-funded ${fundSuccess}/${lowAddresses.length} wallet(s)!`);
      }
    }

    process.exit(0);
  } catch (err) {
    logger.error(`Balance check failed: ${err.message}`);
    console.error(err);
    process.exit(1);
  }
}

/**
 * ─────────────────────────────────────────────────────────────
 * Copy-Mint Engine & Whale Tracker Interactive CLI Mode
 * ─────────────────────────────────────────────────────────────
 */
async function copyMintWizardMode() {
  console.clear();
  logger.banner();
  logger.info('🐋 Copy-Mint Engine & Whale Tracker Wizard\n');

  const { copyAction } = await inquirer.prompt([
    {
      type: 'list',
      name: 'copyAction',
      message: 'Select Copy-Mint Action:',
      choices: [
        {
          name: '🚀 1. Start Live Whale Tracker & Automint (Mempool WS + Blocks)',
          value: 'LIVE'
        },
        {
          name: '📋 2. Manage Tracked Whale Wallets (Add / Remove / List)',
          value: 'MANAGE'
        },
        {
          name: '🔬 3. Test / Simulate Single Transaction Hash (Dry-Run)',
          value: 'SIMULATE'
        },
        {
          name: '🏆 4. Import Top Whales from Scout / Leaderboard',
          value: 'SCOUT_IMPORT'
        },
        {
          name: '◀️ Back to Main Menu',
          value: 'BACK'
        }
      ]
    }
  ]);

  if (copyAction === 'BACK') {
    return await main();
  }

  if (copyAction === 'MANAGE') {
    return await manageTrackedWalletsCli();
  }

  if (copyAction === 'SCOUT_IMPORT') {
    return await importScoutWhalesCli();
  }

  if (copyAction === 'SIMULATE') {
    return await simulateTxCli();
  }

  if (copyAction === 'LIVE') {
    return await startLiveCopyMintCli();
  }
}

async function manageTrackedWalletsCli() {
  logger.separator();
  const wallets = trackedWalletService.getWallets();

  if (wallets.length === 0) {
    logger.warn('No whale wallets currently tracked.');
  } else {
    logger.info(`📋 Currently Tracked Whale Wallets (${wallets.length}):`);
    const Table = require('cli-table3');
    const table = new Table({
      head: ['#', 'Label', 'Address', 'Status'],
      style: { head: ['cyan'] }
    });

    wallets.forEach((w, i) => {
      table.push([
        i + 1,
        w.label || 'Whale',
        w.address,
        w.active !== false ? '\x1b[32mActive\x1b[0m' : '\x1b[31mPaused\x1b[0m'
      ]);
    });
    console.log(table.toString());
  }

  const { manageOpt } = await inquirer.prompt([
    {
      type: 'list',
      name: 'manageOpt',
      message: 'Management Options:',
      choices: [
        { name: '➕ Add Whale Wallet', value: 'ADD' },
        { name: '🗑️ Remove Whale Wallet', value: 'REMOVE' },
        { name: '⏸️ Toggle Active / Pause', value: 'TOGGLE' },
        { name: '◀️ Back', value: 'BACK' }
      ]
    }
  ]);

  if (manageOpt === 'BACK') {
    return await copyMintWizardMode();
  }

  if (manageOpt === 'ADD') {
    const { newAddress, newLabel } = await inquirer.prompt([
      {
        type: 'input',
        name: 'newAddress',
        message: 'Enter Whale EVM Address (0x...):',
        validate: input => (ethers.isAddress(input.trim()) ? true : 'Invalid EVM address')
      },
      {
        type: 'input',
        name: 'newLabel',
        message: 'Enter friendly label (optional):',
        default: 'Alpha Whale'
      }
    ]);

    const added = trackedWalletService.addWallet(newAddress.trim(), newLabel.trim());
    logger.success(`Added whale wallet: ${added.label} (${added.address})`);
    return await manageTrackedWalletsCli();
  }

  if (manageOpt === 'REMOVE') {
    if (wallets.length === 0) return await manageTrackedWalletsCli();
    const { toRemove } = await inquirer.prompt([
      {
        type: 'list',
        name: 'toRemove',
        message: 'Select wallet to remove:',
        choices: wallets.map(w => ({ name: `${w.label} (${w.address})`, value: w.address }))
      }
    ]);

    trackedWalletService.removeWallet(toRemove);
    logger.success(`Removed wallet ${toRemove}`);
    return await manageTrackedWalletsCli();
  }

  if (manageOpt === 'TOGGLE') {
    if (wallets.length === 0) return await manageTrackedWalletsCli();
    const { toToggle } = await inquirer.prompt([
      {
        type: 'list',
        name: 'toToggle',
        message: 'Select wallet to toggle:',
        choices: wallets.map(w => ({ name: `${w.label} - ${w.active !== false ? 'Active' : 'Paused'} (${w.address})`, value: w.address }))
      }
    ]);

    const activeState = trackedWalletService.toggleActive(toToggle);
    logger.success(`Wallet is now: ${activeState ? 'ACTIVE' : 'PAUSED'}`);
    return await manageTrackedWalletsCli();
  }
}

async function importScoutWhalesCli() {
  logger.separator();
  logger.info('🔍 Importing Top Whales from Scout / Leaderboard...');

  const topWalletsFile = path.join(process.cwd(), 'topwqallie.txt');
  let importedCount = 0;

  if (fs.existsSync(topWalletsFile)) {
    const lines = fs.readFileSync(topWalletsFile, 'utf-8').split('\n');
    for (const line of lines) {
      const match = line.match(/0x[a-fA-F0-9]{40}/);
      if (match && ethers.isAddress(match[0])) {
        trackedWalletService.addWallet(match[0], 'Robinhood Whale');
        importedCount++;
      }
    }
  }

  if (importedCount === 0) {
    // Default high alpha examples
    const seedWhales = [
      { address: '0x460d7DFa923C363d6b8F421D599Aee1648a73bEE', label: 'OEGP Alpha Whale' },
      { address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', label: 'Vitalik.eth' }
    ];
    importedCount = trackedWalletService.importFromScout(seedWhales);
  }

  logger.success(`Imported ${importedCount} whale wallet(s) into tracker!`);
  return await manageTrackedWalletsCli();
}

async function simulateTxCli() {
  logger.separator();
  logger.info('🔬 Test & Simulate Copy-Mint from Past Transaction');

  const chainChoices = getChainChoices();
  const { simChain } = await inquirer.prompt([
    {
      type: 'list',
      name: 'simChain',
      message: 'Select Network:',
      choices: chainChoices
    }
  ]);

  const defaultChainRpc = simChain.alchemyPrefix && process.env.ALCHEMY_KEY
    ? expandAlchemyKey(process.env.ALCHEMY_KEY, simChain)
    : (simChain.defaultRpc || process.env.DEFAULT_RPC_URL);

  const { rpcUrl, targetTxHash } = await inquirer.prompt([
    {
      type: 'input',
      name: 'rpcUrl',
      message: 'RPC Endpoint (Enter to use default):',
      default: defaultChainRpc
    },
    {
      type: 'input',
      name: 'targetTxHash',
      message: 'Enter Transaction Hash to Inspect & Simulate:',
      validate: input => (/^0x[a-fA-F0-9]{64}$/.test(input.trim()) ? true : 'Invalid 64-char hex transaction hash')
    }
  ]);

  const provider = connectionManager.createEthersProvider(rpcUrl.trim(), simChain.chainId);
  const sampleWallet = ethers.Wallet.createRandom();

  try {
    const report = await CopyMintEngine.simulate({
      txHash: targetTxHash.trim(),
      provider,
      sampleWallet,
      quantity: 1
    });

    logger.separator();
    logger.success('✅ Simulation Analysis Complete:');
    console.log(`• Target Contract:  \x1b[36m${report.to}\x1b[0m`);
    console.log(`• Original Sender:  \x1b[33m${report.from}\x1b[0m`);
    console.log(`• Method Selector:  \x1b[32m${report.classification.selector}\x1b[0m (${report.classification.selectorName || 'Unknown'})`);
    console.log(`• Confidence:       \x1b[35m${report.classification.confidence.toUpperCase()}\x1b[0m`);
    console.log(`• Payment Mode:     \x1b[32m${report.paymentPlan.paymentMode.toUpperCase()}\x1b[0m (Cost: ${report.paymentPlan.selectedValueEth} ETH)`);
    console.log(`• Execution Gate:   ${report.paymentPlan.shouldExecute ? '\x1b[32mPASSED (Safe to mint)\x1b[0m' : '\x1b[31mREJECTED\x1b[0m'}`);
    console.log(`• Gate Reason:      ${report.paymentPlan.reason}`);
    logger.separator();
  } catch (err) {
    logger.error(`Simulation failed: ${err.message}`);
  }

  const { nextAct } = await inquirer.prompt([
    {
      type: 'list',
      name: 'nextAct',
      message: 'Next action:',
      choices: [{ name: 'Simulate Another Tx', value: 'AGAIN' }, { name: 'Back to Menu', value: 'BACK' }]
    }
  ]);

  if (nextAct === 'AGAIN') return await simulateTxCli();
  return await copyMintWizardMode();
}

async function startLiveCopyMintCli() {
  logger.separator();
  logger.info('🚀 Live Whale Tracker & Automint Setup\n');

  const trackedWallets = trackedWalletService.getWallets().filter(w => w.active !== false);
  if (trackedWallets.length === 0) {
    logger.warn('No active tracked whale wallets found!');
    logger.info('Please add at least one whale wallet before starting live copy-mint.');
    return await manageTrackedWalletsCli();
  }

  const chainChoices = getChainChoices();
  const { selectedChain } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedChain',
      message: 'Select Chain to Monitor:',
      choices: chainChoices
    }
  ]);

  const defaultChainRpc = selectedChain.alchemyPrefix && process.env.ALCHEMY_KEY
    ? expandAlchemyKey(process.env.ALCHEMY_KEY, selectedChain)
    : (selectedChain.defaultRpc || process.env.DEFAULT_RPC_URL);

  const { rpcInput, maxPriceEth, mintQty, gasPreset, recipientAddr } = await inquirer.prompt([
    {
      type: 'input',
      name: 'rpcInput',
      message: 'HTTP RPC Endpoint:',
      default: defaultChainRpc
    },
    {
      type: 'input',
      name: 'maxPriceEth',
      message: 'Maximum ETH price ceiling per wallet:',
      default: '0.05',
      validate: input => (!isNaN(parseFloat(input)) && parseFloat(input) >= 0 ? true : 'Invalid ETH amount')
    },
    {
      type: 'number',
      name: 'mintQty',
      message: 'Quantity to mint per wallet:',
      default: 1
    },
    {
      type: 'list',
      name: 'gasPreset',
      message: 'Select Gas Preset:',
      choices: ['RAPID', 'INSTANT', 'AGGRESSIVE', 'ULTRA', 'STANDARD']
    },
    {
      type: 'input',
      name: 'recipientAddr',
      message: 'NFT Auto-Forward Cold Storage Recipient (optional, press enter to skip):',
      default: process.env.RECIPIENT_ADDRESS || ''
    }
  ]);

  const provider = connectionManager.createEthersProvider(rpcInput.trim(), selectedChain.chainId);
  logger.separator();
  const wallets = await WalletService.promptWalletKeys();

  if (wallets.length === 0) {
    logger.error('At least one burner wallet is required. Exiting.');
    process.exit(1);
  }

  await WalletService.checkBalances(wallets, provider);

  const tracker = new TrackerEngine({
    httpProvider: provider,
    wsRpcUrl: process.env.WS_RPC_URL || selectedChain.feedUrl,
    chainId: selectedChain.chainId,
    enablePending: process.env.ENABLE_PENDING_DETECTION !== 'false'
  });

  logger.separator();
  logger.success(`🚀 Copy-Mint Engine ACTIVE! Listening for ${trackedWallets.length} whale wallet(s)...`);
  logger.info('Press Ctrl+C at any time to stop.\n');

  tracker.on('mint_detected', async (candidate) => {
    logger.info(`\n⚡ [TRIGGER] Whale mint detected from ${candidate.label} (${candidate.sourceWallet})!`);
    await CopyMintEngine.execute({
      candidate,
      wallets,
      provider,
      chainConfig: selectedChain,
      options: {
        quantity: mintQty,
        maxMintEth: parseFloat(maxPriceEth),
        gasMode: gasPreset,
        recipientAddress: recipientAddr.trim() || null,
        autoForward: Boolean(recipientAddr.trim())
      }
    }).catch(err => {
      logger.error(`Execution error: ${err.message}`);
    });
  });

  await tracker.start();

  // Keep process alive
  await new Promise(() => {});
}

// Route: --check, --generate, --balance, or default mint
const args = process.argv.slice(2).map(a => a.toLowerCase());
if (args.includes('--check') || args.includes('-c') || args.includes('check')) {
  checkEligibility();
} else if (args.includes('--generate') || args.includes('-g') || args.includes('generate')) {
  generateWalletsMode();
} else if (args.includes('--balance') || args.includes('-b') || args.includes('--bal') || args.includes('balance')) {
  checkBalancesMode();
} else if (args.includes('--copymint') || args.includes('-cm') || args.includes('copymint')) {
  copyMintWizardMode();
} else {
  main();
}


