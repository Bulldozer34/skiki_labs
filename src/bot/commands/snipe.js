const { ethers } = require('ethers');
const { CHAINS, expandAlchemyKey } = require('../../utils/chains');
const { resolveGasPreset } = require('../../utils/gasPresets');
const { runSnipe } = require('../../core/snipeRunner');
const { riskManager } = require('../../core/riskManager');
const { buildEndpoints } = require('../../utils/rpcPool');
const { checkAllWallets } = require('../../engines/eligibilityChecker');
const { getEthPriceUsd } = require('../../utils/priceFetcher');
const { resolveCollection } = require('../../utils/resolver');
const CollectionService = require('../../services/collectionService');
const connectionManager = require('../../services/connectionManager');
const logger = require('../../utils/logger');
const snipePersistence = require('../../core/snipePersistence');

// In-memory wizard sessions: chatId -> { step, data, token, expiresAt }
const activeWizards = new Map();

/**
 * Handle /snipe command or inline callback steps.
 * @param {object} ctx
 */
async function handleSnipe(ctx) {
  const { client, chatId, args, messageText } = ctx;

  const target = args && args[0] ? args[0].trim() : null;

  if (!target) {
    activeWizards.set(String(chatId), {
      step: 'AWAIT_TARGET',
      data: {},
      expiresAt: Date.now() + 120000
    });

    return await client.sendMessage(
      chatId,
      [
        `<b>🎯 Arm New NFT Snipe</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `Please send the <b>NFT Contract Address</b> (<code>0x...</code>) or <b>OpenSea Collection Slug</b>:`,
        ``,
        `<i>Example: <code>0x7C3Cba7b5e3cC426A5799f154558E3e0b1847d49</code> or <code>quantum-putersrh</code></i>`
      ].join('\n'),
      { parse_mode: 'HTML' }
    );
  }

  // Target provided directly in command
  await startWizardWithTarget(ctx, target);
}

/**
 * Step 1: Prompt Chain Selection
 */
async function startWizardWithTarget(ctx, target) {
  const { client, chatId } = ctx;

  const resolved = resolveCollection(target);
  let contractAddress = resolved.address;
  let collectionSlug = resolved.slug;
  let collectionName = null;
  let detectedChain = resolved.chain ? resolved.chain.toUpperCase() : null;

  // Attempt auto-resolution from slug via OpenSea v2 API
  if (!contractAddress && collectionSlug) {
    try {
      const details = await CollectionService.getCollectionDetails(collectionSlug);
      if (details) {
        contractAddress = details.address;
        collectionName = details.name;
        if (!detectedChain && details.chain) {
          detectedChain = details.chain.toUpperCase();
        }
      }
    } catch (e) {}
  }

  const isAddress = Boolean(contractAddress && ethers.isAddress(contractAddress));

  const wizardState = {
    step: 'SELECT_CHAIN',
    data: {
      target: target,
      collectionSlug: collectionSlug || target,
      contractAddress: contractAddress || (isAddress ? target : null),
      collectionName: collectionName,
      detectedChain: detectedChain,
      isAddress,
      quantity: 1,
      mode: 'PUBLIC',
      startTime: 0
    },
    expiresAt: Date.now() + 180000
  };
  activeWizards.set(String(chatId), wizardState);

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🏹 Robinhood (4663)', callback_data: 'snipe_chain:ROBINHOOD' },
        { text: '🔵 Base (8453)', callback_data: 'snipe_chain:BASE' }
      ],
      [
        { text: '🔷 Arbitrum One (42161)', callback_data: 'snipe_chain:ARBITRUM' },
        { text: '🔴 Optimism (10)', callback_data: 'snipe_chain:OPTIMISM' }
      ],
      [
        { text: '🧪 Robinhood Testnet', callback_data: 'snipe_chain:ROBINHOOD_TESTNET' },
        { text: '💎 Ethereum Mainnet (1)', callback_data: 'snipe_chain:ETHEREUM' }
      ],
      [
        { text: '❌ Cancel', callback_data: 'snipe_cancel' }
      ]
    ]
  };

  const displayTarget = collectionName
    ? `<b>${collectionName}</b>`
    : `<code>${target}</code>`;

  const textLines = [
    `<b>🎯 Step 1/5 — Select Blockchain</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Target: ${displayTarget}`,
    ...(contractAddress ? [`Contract: <code>${contractAddress}</code>`] : []),
    ...(collectionSlug ? [`Slug: <code>${collectionSlug}</code>`] : []),
    ...(detectedChain ? [`Detected Network: <b>${detectedChain}</b>`] : []),
    ``,
    `Select the network where this drop takes place:`
  ];

  await client.sendMessage(chatId, textLines.join('\n'), { parse_mode: 'HTML', reply_markup });
}

/**
 * Handle inline button clicks during /snipe wizard.
 */
async function handleSnipeCallback(ctx, action, param) {
  const { client, chatId, callbackQuery, state } = ctx;
  const wizard = activeWizards.get(String(chatId));

  if (action === 'cancel') {
    activeWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Snipe cancelled.' });
    return await client.editMessageText(chatId, callbackQuery.message.message_id, '❌ <i>Snipe configuration cancelled.</i>', { parse_mode: 'HTML' });
  }

  if (!wizard || Date.now() > wizard.expiresAt) {
    activeWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Session expired. Please run /snipe again.', show_alert: true });
    return;
  }

  // Step 2: Select Mode
  if (action === 'chain') {
    wizard.data.chainKey = param;
    wizard.step = 'SELECT_MODE';
    await client.answerCallbackQuery(callbackQuery.id);

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '🌊 Public Mint (Direct SeaDrop)', callback_data: 'snipe_mode:PUBLIC' }
        ],
        [
          { text: '⚡ OpenSea Allowlist / FCFS', callback_data: 'snipe_mode:ALLOWLIST' }
        ],
        [
          { text: '🔍 Check Wallet Eligibility', callback_data: 'snipe_mode:ELIGIBILITY' }
        ],
        [
          { text: '❌ Cancel', callback_data: 'snipe_cancel' }
        ]
      ]
    };

    const text = [
      `<b>🎯 Step 2/5 — Select Operation Mode</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Target: <code>${wizard.data.target}</code>`,
      `Chain: <b>${param}</b>`,
      ``,
      `Select execution mode:`
    ].join('\n');

    return await client.editMessageText(chatId, callbackQuery.message.message_id, text, { parse_mode: 'HTML', reply_markup });
  }

  // Handle Eligibility Check Mode immediately
  if (action === 'mode' && param === 'ELIGIBILITY') {
    activeWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: 'Checking eligibility...' });
    return await executeEligibilityCheckFromTelegram(ctx, wizard.data, callbackQuery.message.message_id);
  }

  // Step 3: Select Wallets to Mint With
  if (action === 'mode') {
    wizard.data.mode = param;
    wizard.step = 'SELECT_WALLETS';
    await client.answerCallbackQuery(callbackQuery.id);

    const wallets = state.wallets || [];
    const chainConfig = CHAINS[wizard.data.chainKey] || CHAINS.ROBINHOOD;
    const rpcUrl = chainConfig.defaultRpc || 'https://rpc.mainnet.chain.robinhood.com';
    const provider = connectionManager?.createEthersProvider
      ? connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId)
      : new ethers.JsonRpcProvider(rpcUrl);

    // Fetch live balances for each wallet concurrently
    const balanceMap = await Promise.all(wallets.map(async (w, i) => {
      let num = 0;
      try {
        const bal = await provider.getBalance(w.address);
        num = parseFloat(ethers.formatEther(bal));
      } catch (e) {}
      return {
        index: i,
        address: w.address,
        balanceEth: num,
        label: `${w.address.slice(0, 6)}...${w.address.slice(-4)} (${num.toFixed(4)} ETH)`
      };
    }));

    const fundedCount = balanceMap.filter(b => b.balanceEth > 0).length;
    wizard.data.balanceMap = balanceMap;

    const keyboard = [
      [
        { text: `⚡ All Wallets (${wallets.length})`, callback_data: 'snipe_wallets:ALL' },
        { text: `💰 Funded Only (${fundedCount})`, callback_data: 'snipe_wallets:FUNDED' }
      ]
    ];

    // Add individual wallet buttons (up to 6)
    for (let i = 0; i < Math.min(wallets.length, 6); i++) {
      const item = balanceMap[i];
      const icon = item.balanceEth > 0 ? '🟢' : '⚪';
      keyboard.push([
        { text: `${icon} #${i + 1}: ${item.label}`, callback_data: `snipe_wallets:WALLET_${i}` }
      ]);
    }

    if (wallets.length >= 2) {
      keyboard.push([
        { text: `👥 Top 2 Wallets`, callback_data: 'snipe_wallets:TOP_2' },
        ...(wallets.length >= 3 ? [{ text: `👥 Top 3 Wallets`, callback_data: 'snipe_wallets:TOP_3' }] : [])
      ]);
    }

    keyboard.push([{ text: '❌ Cancel', callback_data: 'snipe_cancel' }]);

    const text = [
      `<b>🎯 Step 3/5 — Select Minting Wallets</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Target: <code>${wizard.data.target}</code>`,
      `Chain: <b>${wizard.data.chainKey}</b> | Mode: <b>${wizard.data.mode}</b>`,
      `Total Loaded: <b>${wallets.length}</b> (💰 Funded: <b>${fundedCount}</b>)`,
      ``,
      `Select which wallet(s) will execute this drop:`
    ].join('\n');

    return await client.editMessageText(chatId, callbackQuery.message.message_id, text, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard }
    });
  }

  // Step 4: Handle Wallet Selection & Go to Quantity
  if (action === 'wallets') {
    const wallets = state.wallets || [];
    let selected = [];
    let label = 'All Wallets';

    if (param === 'ALL') {
      selected = [...wallets];
      label = `All Wallets (${selected.length})`;
    } else if (param === 'FUNDED') {
      const bMap = wizard.data.balanceMap || [];
      const fundedIndices = bMap.filter(b => b.balanceEth > 0).map(b => b.index);
      selected = fundedIndices.length > 0 ? fundedIndices.map(i => wallets[i]) : [...wallets];
      label = `Funded Wallets (${selected.length})`;
    } else if (param.startsWith('WALLET_')) {
      const idx = parseInt(param.replace('WALLET_', ''), 10);
      selected = wallets[idx] ? [wallets[idx]] : [wallets[0]];
      const masked = `${selected[0].address.slice(0, 6)}...${selected[0].address.slice(-4)}`;
      label = `Wallet #${idx + 1} (${masked})`;
    } else if (param === 'TOP_2') {
      selected = wallets.slice(0, 2);
      label = `Top 2 Wallets (${selected.length})`;
    } else if (param === 'TOP_3') {
      selected = wallets.slice(0, 3);
      label = `Top 3 Wallets (${selected.length})`;
    }

    wizard.data.selectedWallets = selected;
    wizard.data.walletSelectionLabel = label;
    wizard.step = 'SELECT_QTY';
    await client.answerCallbackQuery(callbackQuery.id);

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '1 NFT', callback_data: 'snipe_qty:1' },
          { text: '2 NFTs', callback_data: 'snipe_qty:2' },
          { text: '3 NFTs', callback_data: 'snipe_qty:3' },
          { text: '5 NFTs', callback_data: 'snipe_qty:5' }
        ],
        [
          { text: '❌ Cancel', callback_data: 'snipe_cancel' }
        ]
      ]
    };

    const text = [
      `<b>🎯 Step 4/5 — Quantity per Wallet</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Target: <code>${wizard.data.target}</code>`,
      `Chain: <b>${wizard.data.chainKey}</b> | Mode: <b>${wizard.data.mode}</b>`,
      `Selected: <b>${label}</b>`,
      ``,
      `Select how many tokens each wallet will mint:`
    ].join('\n');

    return await client.editMessageText(chatId, callbackQuery.message.message_id, text, { parse_mode: 'HTML', reply_markup });
  }

  // Step 5: Post-Mint Action
  if (action === 'qty') {
    wizard.data.quantity = parseInt(param, 10) || 1;
    wizard.step = 'SELECT_POSTMINT';
    await client.answerCallbackQuery(callbackQuery.id);

    const configuredRecipient = state.recipientAddress || process.env.RECIPIENT_ADDRESS;
    const recipientLabel = configuredRecipient
      ? `📬 Transfer to ${configuredRecipient.slice(0, 6)}...${configuredRecipient.slice(-4)}`
      : '📬 Transfer to Recipient Wallet';

    const reply_markup = {
      inline_keyboard: [
        [
          { text: '📦 Keep in Minting Wallets (Default)', callback_data: 'snipe_postmint:KEEP' }
        ],
        [
          { text: recipientLabel, callback_data: 'snipe_postmint:RECIPIENT' }
        ],
        [
          { text: '💰 Instant Flip (Seaport 1.6 Top Offer)', callback_data: 'snipe_postmint:TOP_OFFER' }
        ],
        [
          { text: '❌ Cancel', callback_data: 'snipe_cancel' }
        ]
      ]
    };

    const text = [
      `<b>🎯 Step 5/6 — Post-Mint Disposition</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Target: <code>${wizard.data.target}</code>`,
      `Wallets: <b>${wizard.data.walletSelectionLabel}</b>`,
      `Quantity: <b>${wizard.data.quantity} per wallet</b>`,
      ``,
      `What should happen immediately after minting succeeds?`
    ].join('\n');

    return await client.editMessageText(chatId, callbackQuery.message.message_id, text, { parse_mode: 'HTML', reply_markup });
  }

  // Handle Post-Mint Choice
  if (action === 'postmint') {
    if (param === 'KEEP') {
      wizard.data.postMintConfig = { action: 'NONE' };
      wizard.data.postMintLabel = '📦 Keep in Wallets';
    } else if (param === 'TOP_OFFER') {
      wizard.data.postMintConfig = { action: 'TOP_OFFER', scope: 'ALL', minPriceEth: '0.0' };
      wizard.data.postMintLabel = '💰 Instant Flip (Seaport Top Offer)';
    } else if (param === 'RECIPIENT') {
      const defaultRecipient = state.recipientAddress || process.env.RECIPIENT_ADDRESS;
      if (defaultRecipient) {
        wizard.data.postMintConfig = { action: 'RECIPIENT', recipientAddress: defaultRecipient };
        wizard.data.recipientAddress = defaultRecipient;
        wizard.data.postMintLabel = `📬 Forward to ${defaultRecipient.slice(0, 6)}...${defaultRecipient.slice(-4)}`;
      } else {
        wizard.step = 'AWAIT_RECIPIENT';
        await client.answerCallbackQuery(callbackQuery.id);
        return await client.editMessageText(
          chatId,
          callbackQuery.message.message_id,
          [
            `<b>📬 Enter Recipient Wallet Address</b>`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `Please reply with the EVM <code>0x...</code> address where all minted NFTs should be forwarded:`
          ].join('\n'),
          { parse_mode: 'HTML' }
        );
      }
    }

    wizard.step = 'SELECT_TIMING';
    await client.answerCallbackQuery(callbackQuery.id);
    return await showTimingSelection(ctx, wizard, callbackQuery.message.message_id);
  }

  // Handle Timing choice
  if (action === 'timing') {
    if (param === 'CUSTOM') {
      wizard.step = 'AWAIT_TIME';
      await client.answerCallbackQuery(callbackQuery.id);

      return await client.editMessageText(
        chatId,
        callbackQuery.message.message_id,
        [
          `<b>⏰ Enter Target Drop Time</b>`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `Please reply with the scheduled time in <code>HH:MM:SS</code> format (e.g. <code>15:30:00</code>) or minutes from now (e.g. <code>10m</code>):`
        ].join('\n'),
        { parse_mode: 'HTML' }
      );
    }

    if (param === 'AUTO_SYNC') {
      wizard.data.startTime = 0; // 0 engages on-chain sync
      if (wizard.data.contractAddress) {
        try {
          const chainKey = wizard.data.chainKey || 'ROBINHOOD';
          const chainConfig = CHAINS[chainKey] || CHAINS.ROBINHOOD;
          const { SEADROP_ADDRESSES, getPublicDropParams } = require('../../contracts/seadrop');
          const seadropAddress = SEADROP_ADDRESSES[chainKey] || SEADROP_ADDRESSES.ROBINHOOD;
          const rpcUrl = chainConfig.defaultRpc || 'https://rpc.mainnet.chain.robinhood.com';
          const provider = connectionManager?.createEthersProvider
            ? connectionManager.createEthersProvider(rpcUrl, chainConfig.chainId)
            : new ethers.JsonRpcProvider(rpcUrl);
          const dropParams = await getPublicDropParams(provider, seadropAddress, wizard.data.contractAddress);
          if (dropParams && dropParams.startTime > 0n) {
            wizard.data.onChainStartTime = Number(dropParams.startTime);
          }
        } catch (e) {}
      }
    } else {
      wizard.data.startTime = 1;
    }

    wizard.step = 'CONFIRM';
    await client.answerCallbackQuery(callbackQuery.id);
    return await showConfirmationCard(ctx, wizard, callbackQuery.message.message_id);
  }

  // Step 6: Execute / Arm
  if (action === 'execute') {
    if (wizard.confirmToken !== param) {
      await client.answerCallbackQuery(callbackQuery.id, { text: 'Invalid or stale confirmation token.', show_alert: true });
      return;
    }

    const dropData = { ...wizard.data };
    activeWizards.delete(String(chatId));
    await client.answerCallbackQuery(callbackQuery.id, { text: '⚡ Sniper Armed & Scheduled!' });

    // Arm as a concurrent background job
    scheduleDropInBackground(ctx, dropData, callbackQuery.message.message_id);
  }
}

/**
 * Show Step 6: Scheduling & Timing Selection
 */
async function showTimingSelection(ctx, wizard, messageId) {
  const { client, chatId } = ctx;
  const reply_markup = {
    inline_keyboard: [
      [
        { text: '⚡ Fire Immediately', callback_data: 'snipe_timing:IMMEDIATE' }
      ],
      [
        { text: '🎯 Auto-Sync On-Chain Drop Time', callback_data: 'snipe_timing:AUTO_SYNC' }
      ],
      [
        { text: '⏰ Enter Custom Time', callback_data: 'snipe_timing:CUSTOM' }
      ],
      [
        { text: '❌ Cancel', callback_data: 'snipe_cancel' }
      ]
    ]
  };

  const text = [
    `<b>🎯 Step 6/6 — Scheduling & Timing</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `Target: <code>${wizard.data.target}</code>`,
    `Wallets: <b>${wizard.data.walletSelectionLabel}</b>`,
    `Quantity: <b>${wizard.data.quantity} per wallet</b>`,
    `Post-Mint: <b>${wizard.data.postMintLabel || '📦 Keep in Wallets'}</b>`,
    ``,
    `How would you like to schedule this drop?`
  ].join('\n');

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup });
  } else {
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  }
}

/**
 * Show Review & Confirm Card
 */
async function showConfirmationCard(ctx, wizard, messageId) {
  const { client, chatId, state } = ctx;
  const token = Math.random().toString(36).slice(2, 10);
  wizard.confirmToken = token;

  const selectedWallets = wizard.data.selectedWallets || state.wallets || [];
  const walletLabel = wizard.data.walletSelectionLabel || `${selectedWallets.length} Wallets`;

  const nowSec = Math.floor(Date.now() / 1000);
  let timeStr = '⚡ Immediate Execution';
  if (wizard.data.startTime > 1) {
    const diff = wizard.data.startTime - nowSec;
    timeStr = `${new Date(wizard.data.startTime * 1000).toLocaleTimeString()} (${diff > 0 ? `in ${Math.floor(diff / 60)}m ${diff % 60}s` : 'Due now'})`;
  } else if (wizard.data.startTime === 0) {
    if (wizard.data.onChainStartTime && wizard.data.onChainStartTime > nowSec) {
      const diff = wizard.data.onChainStartTime - nowSec;
      timeStr = `🎯 ${new Date(wizard.data.onChainStartTime * 1000).toLocaleTimeString()} (in ${Math.floor(diff / 60)}m ${diff % 60}s) — On-Chain Drop Time`;
    } else {
      timeStr = '🎯 Auto-Sync On-Chain Drop Time (T-0 Execution)';
    }
  }

  const displayTarget = wizard.data.collectionName
    ? `<b>${wizard.data.collectionName}</b>`
    : `<code>${wizard.data.target}</code>`;

  const text = [
    `<b>⚡ Review & Confirm Mint Arming</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🎯 <b>Target:</b> ${displayTarget}`,
    ...(wizard.data.contractAddress ? [`📄 <b>Contract:</b> <code>${wizard.data.contractAddress}</code>`] : []),
    `🔗 <b>Chain:</b> ${wizard.data.chainKey}`,
    `⚙️ <b>Mode:</b> ${wizard.data.mode}`,
    `💼 <b>Wallets:</b> ${walletLabel}`,
    `🔢 <b>Quantity per Wallet:</b> ${wizard.data.quantity}`,
    `📦 <b>Total NFTs:</b> ${selectedWallets.length * wizard.data.quantity}`,
    `🎁 <b>Post-Mint:</b> ${wizard.data.postMintLabel || '📦 Keep in Wallets'}`,
    `⏰ <b>Scheduled Time:</b> ${timeStr}`,
    `⚡ <b>Gas Profile:</b> Auto-Optimized`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>Tap Confirm below to arm the sniper engine. Button expires in 60s.</i>`
  ].join('\n');

  const reply_markup = {
    inline_keyboard: [
      [
        { text: '🚀 CONFIRM & ARM NOW', callback_data: `snipe_execute:${token}` }
      ],
      [
        { text: '❌ Cancel', callback_data: 'snipe_cancel' }
      ]
    ]
  };

  if (messageId) {
    return await client.editMessageText(chatId, messageId, text, { parse_mode: 'HTML', reply_markup });
  } else {
    return await client.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
  }
}

/**
 * Execute Eligibility Check from Telegram
 */
async function executeEligibilityCheckFromTelegram(ctx, data, messageId) {
  const { client, chatId, state } = ctx;
  const wallets = state.wallets || [];

  if (wallets.length === 0) {
    return await client.editMessageText(chatId, messageId, '❌ No wallets loaded to check eligibility.');
  }

  await client.editMessageText(
    chatId,
    messageId,
    `⏳ <i>Querying OpenSea API to check eligibility for ${wallets.length} wallet(s)...</i>`,
    { parse_mode: 'HTML' }
  );

  try {
    const chainKey = data.chainKey || 'ROBINHOOD';
    const chainConfig = CHAINS[chainKey] || CHAINS.ROBINHOOD;

    const slug = data.collectionSlug || resolveCollection(data.target).slug || data.target;
    const results = await checkAllWallets({
      wallets,
      collectionSlug: slug,
      quantity: data.quantity || 1
    });

    const eligibleCount = results.filter(r => r.status === 'ELIGIBLE').length;
    const deniedCount = results.filter(r => r.status === 'DENIED').length;
    const notLiveCount = results.filter(r => r.status === 'NOT_LIVE').length;

    const lines = [
      `<b>🔍 OpenSea Allowlist Eligibility Report</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `🎯 <b>Target:</b> <code>${data.target}</code> (${chainKey})`,
      `✅ <b>Eligible:</b> ${eligibleCount}/${wallets.length}`,
      ...(deniedCount > 0 ? [`❌ <b>Denied:</b> ${deniedCount}`] : []),
      ...(notLiveCount > 0 ? [`⏳ <b>Stage Not Live:</b> ${notLiveCount}`] : []),
      `━━━━━━━━━━━━━━━━━━━━`,
      `<b>Wallet Breakdown:</b>`
    ];

    results.forEach((r, idx) => {
      const masked = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
      let statusIcon = '✅';
      if (r.status === 'DENIED') statusIcon = '❌';
      if (r.status === 'NOT_LIVE') statusIcon = '⏳';
      lines.push(`• #${idx + 1} <code>${masked}</code>: ${statusIcon} ${r.status}`);
    });

    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    if (eligibleCount > 0) {
      lines.push(`<i>Confirmed eligible! You are ready to run <code>/snipe</code> in Allowlist mode.</i>`);
    } else if (notLiveCount > 0) {
      lines.push(`<i>Stage is not live yet on OpenSea. Re-run this check closer to drop time.</i>`);
    }

    await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    await client.sendMessage(chatId, `❌ Eligibility check failed: ${err.message}`);
  }
}

/**
 * Schedule Drop as Concurrent Background Task
 */
async function scheduleDropInBackground(ctx, data, messageId = null, existingDropId = null) {
  const { client, chatId, state } = ctx;

  const dropId = existingDropId || data.id || `drop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const chainKey = data.chainKey || 'ROBINHOOD';
  const chainConfig = CHAINS[chainKey] || CHAINS.ROBINHOOD;

  const allWallets = state.wallets || [];
  const wallets = data.selectedWallets && data.selectedWallets.length > 0
    ? data.selectedWallets
    : allWallets;

  if (wallets.length === 0) {
    if (chatId) await client.sendMessage(chatId, '❌ Cannot execute: No wallets selected.').catch(() => {});
    return;
  }

  // Register in active background jobs
  const abortController = new AbortController();
  state.activeSnipes = state.activeSnipes || new Map();
  const dropJob = {
    id: dropId,
    abortController,
    target: data.target,
    contractAddress: data.contractAddress,
    collectionName: data.collectionName,
    collectionSlug: data.collectionSlug,
    chainKey,
    mode: data.mode,
    quantity: data.quantity,
    startTime: data.startTime,
    walletsCount: wallets.length,
    selectedWallets: wallets,
    selectedWalletAddresses: wallets.map(w => w.address),
    postMintLabel: data.postMintLabel || '📦 Keep in Wallets',
    postMintConfig: data.postMintConfig || null,
    recipientAddress: data.recipientAddress || state.recipientAddress || process.env.RECIPIENT_ADDRESS || null,
    walletSelectionLabel: data.walletSelectionLabel,
    createdAt: data.createdAt || Date.now()
  };
  state.activeSnipes.set(dropId, dropJob);

  // Persist to disk so the armed snipe survives daemon restarts
  snipePersistence.save(state.activeSnipes);

  const displayTarget = data.collectionName
    ? `<b>${data.collectionName}</b>`
    : `<code>${data.target}</code>`;

  const confirmLines = [
    `⚡ <b>Sniper Armed & Scheduled in Background!</b>`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `🎯 <b>Target:</b> ${displayTarget}`,
    ...(data.contractAddress ? [`📄 <b>Contract:</b> <code>${data.contractAddress}</code>`] : []),
    `🔗 <b>Chain:</b> ${chainKey} | <b>Mode:</b> ${data.mode}`,
    `💼 <b>Wallets:</b> ${data.walletSelectionLabel || `${wallets.length} Wallets`}`,
    `🔢 <b>Quantity:</b> ${data.quantity} NFT(s) per wallet`,
    `🎁 <b>Post-Mint:</b> ${data.postMintLabel || '📦 Keep in Wallets'}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `<i>The daemon will monitor drop clock and execute at T-0. Send /drops to view or cancel.</i>`
  ];

  if (messageId && chatId) {
    await client.editMessageText(chatId, messageId, confirmLines.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
  } else if (!data.silent && chatId) {
    await client.sendMessage(chatId, confirmLines.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
  }

  // Background Async Execution
  (async () => {
    try {
      const alchemyUrl = process.env.ALCHEMY_KEY ? expandAlchemyKey(process.env.ALCHEMY_KEY, chainConfig) : null;
      const primaryRpc = alchemyUrl || chainConfig.defaultRpc || 'https://rpc.mainnet.chain.robinhood.com';
      const provider = connectionManager?.createEthersProvider
        ? connectionManager.createEthersProvider(primaryRpc, chainConfig.chainId)
        : new ethers.JsonRpcProvider(primaryRpc);

      // Force enableQuickNode: true so private VIP endpoint is always engaged for hyped drops
      const endpointData = buildEndpoints(chainConfig, primaryRpc, { enableQuickNode: true });

      // Pre-warm sockets across all high-speed endpoints immediately
      connectionManager.preWarmSockets(endpointData.urls).catch(() => {});

      const isL2 = chainConfig.chainId !== 1;
      const gasSettings = resolveGasPreset(isL2 ? 'turbo' : 'ultra', { isL2 });

      // Resolve contract address if not already resolved
      let nftContractAddress = data.contractAddress;
      if (!nftContractAddress && ethers.isAddress(data.target)) {
        nftContractAddress = data.target;
      }
      if (!nftContractAddress && data.collectionSlug) {
        nftContractAddress = await CollectionService.getContractFromSlug(data.collectionSlug);
      }
      if (!nftContractAddress && data.target && !data.target.startsWith('0x')) {
        const resolved = resolveCollection(data.target);
        if (resolved.address) {
          nftContractAddress = resolved.address;
        } else if (resolved.slug) {
          nftContractAddress = await CollectionService.getContractFromSlug(resolved.slug);
        }
      }

      if (!nftContractAddress && data.mode === 'PUBLIC') {
        throw new Error(`Direct SeaDrop Public Mint requires a 0x contract address. Could not resolve contract for "${data.target}". Please run /snipe with the 0x contract address directly.`);
      }

      const collectionSlug = data.collectionSlug || (data.target && !data.target.startsWith('0x') ? resolveCollection(data.target).slug : null) || data.target;

      const onFiring = async () => {
        logger.info(`[Snipe] 🚀 Drop countdown reached T-0! Firing transactions now for ${data.target}`);
        await client.sendMessage(
          chatId,
          [
            `🚀 <b>FIRING SCHEDULED MINT NOW!</b>`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `🎯 <b>Target:</b> ${data.collectionName ? `<b>${data.collectionName}</b>` : `<code>${data.target}</code>`}`,
            `📄 <b>Contract:</b> <code>${nftContractAddress || data.target}</code>`,
            `🔗 <b>Chain:</b> ${chainKey} | <b>Mode:</b> ${data.mode}`,
            `💼 <b>Wallets:</b> ${wallets.length} burner wallets`,
            `🔢 <b>Quantity:</b> ${data.quantity} NFT(s) per wallet`,
            `🎁 <b>Post-Mint:</b> ${data.postMintLabel || '📦 Keep in Wallets'}`,
            `━━━━━━━━━━━━━━━━━━━━`,
            `<i>Blasting transactions to mempool across redundant RPCs...</i>`
          ].join('\n'),
          { parse_mode: 'HTML' }
        ).catch(() => {});
      };

      const results = await runSnipe({
        mode: data.mode,
        wallets,
        provider,
        endpoints: endpointData.endpoints,
        rpcUrls: endpointData.urls,
        feedUrl: chainConfig.feedUrl,
        nftContractAddress: nftContractAddress || data.target,
        collectionSlug: collectionSlug || data.target,
        chain: chainConfig,
        quantity: data.quantity,
        gasSettings,
        startTime: data.startTime,
        postMintConfig: data.postMintConfig || null,
        recipientAddress: data.recipientAddress || state.recipientAddress || process.env.RECIPIENT_ADDRESS || null,
        onFiring,
        onAlert: (msg) => {
          client.sendMessage(chatId, msg, { parse_mode: 'HTML' }).catch(() => {});
        },
        signal: abortController.signal
      });

      // Cleanup from active snipes once completed
      state.activeSnipes.delete(dropId);
      snipePersistence.remove(dropId);

      const successCount = results.filter(r => r.status === 'SUCCESS').length;
      const failCount = results.filter(r => r.status !== 'SUCCESS').length;

      const lines = [
        `🏁 <b>SCHEDULED DROP COMPLETED!</b>`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `🎯 <b>Target:</b> ${data.collectionName ? `<b>${data.collectionName}</b>` : `<code>${data.target}</code>`}`,
        `📄 <b>Contract:</b> <code>${nftContractAddress || data.target}</code>`,
        `🔗 <b>Chain:</b> ${chainKey} | <b>Mode:</b> ${data.mode}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `📊 <b>Results:</b> ✅ <b>${successCount} Succeeded</b> | ❌ <b>${failCount} Failed</b>`
      ];

      results.forEach((r, idx) => {
        const shortAddr = `${r.wallet.address.slice(0, 6)}...${r.wallet.address.slice(-4)}`;
        if (r.status === 'SUCCESS') {
          lines.push(`• #${idx + 1} <code>${shortAddr}</code>: 🟢 <code>${r.txHash ? `${r.txHash.slice(0, 10)}...` : 'SUCCESS'}</code> (${r.mintDurationMs || 0}ms)`);
        } else {
          lines.push(`• #${idx + 1} <code>${shortAddr}</code>: 🔴 ${r.error || 'Failed'}`);
        }
      });

      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
      lines.push(`<i>All mint history recorded to disk.</i>`);

      if (chatId) {
        await client.sendMessage(chatId, lines.join('\n'), { parse_mode: 'HTML' }).catch(() => {});
      }
    } catch (err) {
      state.activeSnipes.delete(dropId);
      snipePersistence.remove(dropId);
      if (err.name === 'AbortError' || err.message?.includes('cancelled')) {
        logger.info(`[Snipe] Background drop cancelled cleanly for ${data.target}`);
        return;
      }
      logger.error(`[Snipe] Background drop failed for ${data.target}: ${err.message}`);
      if (chatId) {
        await client.sendMessage(chatId, `❌ Snipe failed for <code>${data.target}</code>: ${err.message}`, { parse_mode: 'HTML' }).catch(() => {});
      }
    }
  })();
}

/**
 * Handle pending text inputs (e.g. target address or custom schedule time)
 */
function handlePendingInput(ctx) {
  const wizard = activeWizards.get(String(ctx.chatId));
  if (!wizard) return false;

  const text = ctx.messageText.trim();
  if (text.startsWith('/')) return false; // ignore commands

  if (wizard.step === 'AWAIT_TARGET') {
    startWizardWithTarget(ctx, text);
    return true;
  }

  if (wizard.step === 'AWAIT_RECIPIENT') {
    if (!ethers.isAddress(text)) {
      ctx.client.sendMessage(ctx.chatId, `❌ <b>Invalid EVM Address:</b> <code>${text}</code>\n\nPlease enter a valid 20-byte address (e.g. <code>0x...</code>):`, { parse_mode: 'HTML' });
      return true;
    }
    const checksummed = ethers.getAddress(text);
    wizard.data.postMintConfig = { action: 'RECIPIENT', recipientAddress: checksummed };
    wizard.data.recipientAddress = checksummed;
    wizard.data.postMintLabel = `📬 Forward to ${checksummed.slice(0, 6)}...${checksummed.slice(-4)}`;
    wizard.step = 'SELECT_TIMING';
    showTimingSelection(ctx, wizard, null);
    return true;
  }

  if (wizard.step === 'AWAIT_TIME') {
    let targetEpochSec = 0;
    const now = new Date();
    const lower = text.toLowerCase();

    if (lower.endsWith('h')) {
      const hours = parseFloat(lower.replace('h', ''));
      if (!isNaN(hours) && hours > 0) {
        targetEpochSec = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
      }
    } else if (lower.endsWith('m')) {
      const mins = parseFloat(lower.replace('m', ''));
      if (!isNaN(mins) && mins > 0) {
        targetEpochSec = Math.floor(Date.now() / 1000) + Math.round(mins * 60);
      }
    } else if (lower.endsWith('s')) {
      const secs = parseFloat(lower.replace('s', ''));
      if (!isNaN(secs) && secs > 0) {
        targetEpochSec = Math.floor(Date.now() / 1000) + Math.round(secs);
      }
    } else if (text.includes(':')) {
      const parts = text.split(':').map(Number);
      if (!parts.some(isNaN) && parts.length >= 2) {
        const targetDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], parts[2] || 0);
        if (targetDate.getTime() < now.getTime()) {
          targetDate.setDate(targetDate.getDate() + 1); // tomorrow
        }
        targetEpochSec = Math.floor(targetDate.getTime() / 1000);
      }
    } else {
      const num = Number(text);
      if (!isNaN(num) && num > 1e8) {
        targetEpochSec = num > 1e11 ? Math.floor(num / 1000) : Math.floor(num);
      } else {
        const parsedDate = new Date(text).getTime();
        if (!isNaN(parsedDate) && parsedDate > 0) {
          targetEpochSec = Math.floor(parsedDate / 1000);
        }
      }
    }

    if (!targetEpochSec || targetEpochSec <= 0) {
      ctx.client.sendMessage(
        ctx.chatId,
        `❌ <b>Invalid Time Format:</b> <code>${text}</code>\n\n` +
        `Please provide a valid time format:\n` +
        `• Minutes / Seconds / Hours: <code>10m</code>, <code>30s</code>, <code>1h</code>\n` +
        `• Clock time: <code>15:30:00</code> or <code>15:30</code>\n` +
        `• Unix Epoch: <code>1726350000</code>\n` +
        `• ISO Date: <code>2026-09-15T15:30:00Z</code>`,
        { parse_mode: 'HTML' }
      );
      return true;
    }

    wizard.data.startTime = targetEpochSec;
    wizard.step = 'CONFIRM';
    showConfirmationCard(ctx, wizard, null);
    return true;
  }

  return false;
}

/**
 * Rehydrate persisted snipes from disk on daemon boot / restart.
 * @param {object} ctx Context with client, allowedChatId, state
 * @returns {Promise<number>} Count of rehydrated snipes
 */
async function rehydratePersistedSnipes(ctx) {
  const { client, allowedChatId, state } = ctx;
  const persisted = snipePersistence.load();
  if (!persisted || persisted.length === 0) return 0;

  logger.info(`[SnipePersistence] Found ${persisted.length} persisted drop(s) on disk. Re-arming...`);

  let restoredCount = 0;
  for (const dropData of persisted) {
    // Avoid duplicate scheduling
    if (state.activeSnipes && state.activeSnipes.has(dropData.id)) {
      continue;
    }

    // Reconnect wallet instances from state.wallets
    let selectedWallets = [];
    if (dropData.selectedWalletAddresses && Array.isArray(dropData.selectedWalletAddresses)) {
      const addressSet = new Set(dropData.selectedWalletAddresses.map(a => a.toLowerCase()));
      selectedWallets = (state.wallets || []).filter(w => addressSet.has(w.address.toLowerCase()));
    }
    if (selectedWallets.length === 0) {
      selectedWallets = state.wallets || [];
    }
    dropData.selectedWallets = selectedWallets;
    dropData.silent = true;

    // Re-arm background execution with existing drop ID
    scheduleDropInBackground({
      client,
      chatId: allowedChatId,
      state
    }, dropData, null, dropData.id);

    restoredCount++;
  }

  if (restoredCount > 0 && allowedChatId && client) {
    const text = [
      `🔄 <b>Daemon Rehydrated ${restoredCount} Armed Snipe(s)!</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `Your drop(s) survived daemon restart and remain armed in the background.`,
      `Send /drops to view active timers.`
    ].join('\n');
    await client.sendMessage(allowedChatId, text, { parse_mode: 'HTML' }).catch(() => {});
  }

  return restoredCount;
}

module.exports = {
  handleSnipe,
  handleSnipeCallback,
  handlePendingInput,
  scheduleDropInBackground,
  rehydratePersistedSnipes
};
