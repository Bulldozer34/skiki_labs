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
const { runPublicMint } = require('./src/engines/publicMintEngine');
const { runAllowlistMint } = require('./src/engines/allowlistMintEngine');

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
    const provider = new ethers.JsonRpcProvider(rpcUrl);

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
    // Fetch live base fee to assist user
    let liveBaseFeeGwei = process.env.DEFAULT_MAX_FEE_GWEI || '0.1';
    try {
      const feeData = await provider.getFeeData();
      if (feeData.maxFeePerGas) {
        liveBaseFeeGwei = ethers.formatUnits(feeData.maxFeePerGas, 'gwei');
        logger.info(`Live Network Max Fee: ~${parseFloat(liveBaseFeeGwei).toFixed(3)} Gwei`);
      }
    } catch (e) {}

    const defaultMaxFee = process.env.DEFAULT_MAX_FEE_GWEI || (parseFloat(liveBaseFeeGwei) * 1.5).toFixed(2);
    const defaultPriorityFee = process.env.DEFAULT_PRIORITY_FEE_GWEI || '0.1';
    const defaultGasLimit = parseInt(process.env.DEFAULT_GAS_LIMIT) || 300000;

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

      startTime = await Scheduler.autoSchedule(collectionSlug, authHeaders);
    } else if (timingChoice === 'CUSTOM_TIME') {
      const { timeInput } = await inquirer.prompt([
        {
          type: 'input',
          name: 'timeInput',
          message: 'Enter Start Time (Unix timestamp in seconds or ISO format):',
          validate: val => {
            if (/^\d{10}$/.test(val.trim())) return true;
            if (!isNaN(Date.parse(val.trim()))) return true;
            return 'Please enter a valid 10-digit unix timestamp or ISO date string';
          }
        }
      ]);

      const raw = timeInput.trim();
      startTime = /^\d{10}$/.test(raw) ? parseInt(raw) : Math.floor(Date.parse(raw) / 1000);
      logger.info(`Scheduled for: ${new Date(startTime * 1000).toLocaleString()}`);
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
    console.log(`Start Time:     ${startTime ? new Date(startTime * 1000).toLocaleTimeString() : 'Immediate'}`);
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

main();
