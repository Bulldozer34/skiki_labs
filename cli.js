#!/usr/bin/env node

require('dotenv').config();
const inquirer = require('inquirer');
const { ethers } = require('ethers');
const logger = require('./src/utils/logger');
const { CHAINS, getChainChoices, expandAlchemyKey } = require('./src/utils/chains');
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
        message: 'Select Minting Mode:',
        choices: [
          {
            name: '⚡ OpenSea Allowlist / FCFS (Signed Mint via GraphQL)',
            value: 'ALLOWLIST'
          },
          {
            name: '🌊 Public Mint (Direct SeaDrop Contract - No OpenSea Auth Needed)',
            value: 'PUBLIC'
          }
        ]
      }
    ]);

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
    // STEP 7: Gas Configuration
    // ---------------------------------------------------------
    logger.separator();
    const isL2 = chainConfig.chainId !== 1; // Robinhood, Base, Arbitrum, Optimism, etc.
    let liveBaseFeeGwei = isL2 ? '0.04' : '25.0';
    try {
      const feeData = await provider.getFeeData();
      if (feeData.maxFeePerGas) {
        liveBaseFeeGwei = ethers.formatUnits(feeData.maxFeePerGas, 'gwei');
        logger.info(`Live Network Max Fee: ~${parseFloat(liveBaseFeeGwei).toFixed(3)} Gwei`);
      }
    } catch (e) {}

    const calculatedMaxFee = (parseFloat(liveBaseFeeGwei) * 1.5).toFixed(3);
    const defaultMaxFee = isL2 
      ? Math.max(0.05, Math.min(parseFloat(calculatedMaxFee) || 0.1, 0.5)).toString() 
      : (process.env.DEFAULT_MAX_FEE_GWEI || '25.0');
    const defaultPriorityFee = isL2 ? '0.01' : (process.env.DEFAULT_PRIORITY_FEE_GWEI || '1.5');
    const defaultGasLimit = isL2 ? 200000 : (parseInt(process.env.DEFAULT_GAS_LIMIT) || 300000);

    const gasAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'maxFeePerGas',
        message: 'Max Fee Per Gas (in Gwei):',
        default: defaultMaxFee
      },
      {
        type: 'input',
        name: 'maxPriorityFeePerGas',
        message: 'Priority Tip (in Gwei):',
        default: defaultPriorityFee
      },
      {
        type: 'number',
        name: 'gasLimit',
        message: 'Gas Limit:',
        default: defaultGasLimit
      }
    ]);

    const gasSettings = {
      maxFeePerGas: gasAnswers.maxFeePerGas.trim(),
      maxPriorityFeePerGas: gasAnswers.maxPriorityFeePerGas.trim(),
      gasLimit: gasAnswers.gasLimit
    };

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

    // Build multi-RPC array for broadcast racing
    const rpcUrls = [rpcUrl];
    if (chainConfig.defaultRpc && chainConfig.defaultRpc !== rpcUrl) {
      rpcUrls.push(chainConfig.defaultRpc);
    }
    if (process.env.ANKR_KEY && chainConfig.chainId === 1) {
      rpcUrls.push(`https://rpc.ankr.com/eth/${process.env.ANKR_KEY.trim()}`);
    }
    if (chainConfig.chainId === 1 && !rpcUrls.includes('https://eth.llamarpc.com')) {
      rpcUrls.push('https://eth.llamarpc.com');
    }

    const runConfig = {
      wallets,
      provider,
      rpcUrls,
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

// Route: --check, --generate, or default mint
const args = process.argv.slice(2).map(a => a.toLowerCase());
if (args.includes('--check') || args.includes('-c') || args.includes('check')) {
  checkEligibility();
} else if (args.includes('--generate') || args.includes('-g') || args.includes('generate')) {
  generateWalletsMode();
} else {
  main();
}
