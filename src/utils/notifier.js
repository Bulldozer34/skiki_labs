const axios = require('axios');
const logger = require('./logger');

/**
 * Escape HTML special characters for Telegram formatting
 */
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Multi-channel notifier for Discord Webhooks and Telegram Bots
 */
const Notifier = {
  /**
   * Send alert to Discord webhook if configured and verified
   * @param {object} embedData 
   */
  async sendDiscord(embedData) {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl || !webhookUrl.trim()) return;

    try {
      // Validate webhook belongs to official Discord domain
      const parsed = new URL(webhookUrl.trim());
      const isDiscord = parsed.protocol === 'https:' &&
        (parsed.hostname === 'discord.com' || parsed.hostname === 'discordapp.com') &&
        parsed.pathname.startsWith('/api/webhooks/');

      if (!isDiscord) {
        logger.warn('DISCORD_WEBHOOK_URL rejected: Must be a valid https://discord.com/api/webhooks/ URL');
        return;
      }

      await axios.post(webhookUrl.trim(), {
        username: 'NFT Mint Sniper Bot',
        avatar_url: 'https://opensea.io/static/images/logos/opensea-logo.png',
        embeds: [embedData]
      }, { timeout: 4000 });
    } catch (err) {
      logger.warn(`Discord webhook notice: ${err.message}`);
    }
  },

  /**
   * Send message to Telegram chat if configured
   * @param {string} text 
   */
  async sendTelegram(text) {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!botToken || !chatId) return;

    try {
      const url = `https://api.telegram.org/bot${botToken.trim()}/sendMessage`;
      await axios.post(url, {
        chat_id: chatId.trim(),
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      }, { timeout: 4000 });
    } catch (err) {
      logger.warn(`Telegram notice: ${err.message}`);
    }
  },

  /**
   * Send a formatted mint result alert
   * @param {object} result { address, status, txHash, explorerUrl, contractAddress, latencyMs, blockNumber, error }
   */
  async sendMintAlert(result) {
    const isSuccess = result.status === 'SUCCESS';
    const shortAddr = `${result.address.slice(0, 6)}...${result.address.slice(-4)}`;
    const txLink = result.txHash && result.explorerUrl ? `${result.explorerUrl}/tx/${result.txHash}` : result.txHash;

    // 1. Discord Embed
    const discordEmbed = {
      title: isSuccess ? '⚡ Mint Successful!' : '❌ Mint Failed',
      color: isSuccess ? 0x00FF88 : 0xFF3366,
      fields: [
        { name: 'Wallet', value: `\`${shortAddr}\``, inline: true },
        { name: 'Status', value: result.status, inline: true },
        { name: 'Contract', value: `\`${result.contractAddress || 'N/A'}\``, inline: false }
      ],
      timestamp: new Date().toISOString()
    };

    if (result.txHash) {
      discordEmbed.fields.push({
        name: 'Transaction',
        value: result.explorerUrl ? `[View on Explorer](${result.explorerUrl}/tx/${result.txHash})` : `\`${result.txHash}\``,
        inline: false
      });
    }

    if (result.blockNumber) {
      discordEmbed.fields.push({ name: 'Block', value: `#${result.blockNumber}`, inline: true });
    }

    if (result.latencyMs) {
      discordEmbed.fields.push({ name: 'Latency', value: `${result.latencyMs}ms`, inline: true });
    }

    if (result.error) {
      discordEmbed.fields.push({ name: 'Error', value: `\`${result.error.slice(0, 500)}\``, inline: false });
    }

    // 2. Telegram Message (with HTML entity escaping)
    const safeError = escapeHtml(result.error ? result.error.slice(0, 300) : '');
    const safeContract = escapeHtml(result.contractAddress || 'N/A');
    const safeAddr = escapeHtml(shortAddr);

    const tgText = `
<b>${isSuccess ? '⚡ NFT Mint Successful!' : '❌ NFT Mint Failed'}</b>
<b>Wallet:</b> <code>${safeAddr}</code>
<b>Contract:</b> <code>${safeContract}</code>
${result.txHash ? `<b>Tx:</b> <a href="${escapeHtml(txLink)}">View Transaction</a>` : ''}
${result.blockNumber ? `<b>Block:</b> #${result.blockNumber}` : ''}
${result.latencyMs ? `<b>Latency:</b> ${result.latencyMs}ms` : ''}
${safeError ? `<b>Error:</b> <code>${safeError}</code>` : ''}
`.trim();

    // Fire concurrently in background
    await Promise.allSettled([
      this.sendDiscord(discordEmbed),
      this.sendTelegram(tgText)
    ]);
  },

  /**
   * Send an NFT forwarding alert
   * @param {object} forwardInfo { tokenId, fromAddress, toAddress, txHash, explorerUrl }
   */
  async sendForwardAlert(forwardInfo) {
    const fromShort = `${forwardInfo.fromAddress.slice(0, 6)}...${forwardInfo.fromAddress.slice(-4)}`;
    const toShort = `${forwardInfo.toAddress.slice(0, 6)}...${forwardInfo.toAddress.slice(-4)}`;
    const txLink = forwardInfo.txHash && forwardInfo.explorerUrl ? `${forwardInfo.explorerUrl}/tx/${forwardInfo.txHash}` : forwardInfo.txHash;

    const discordEmbed = {
      title: '🔄 NFT Forwarded',
      color: 0x3399FF,
      fields: [
        { name: 'Token ID', value: `#${forwardInfo.tokenId}`, inline: true },
        { name: 'From', value: `\`${fromShort}\``, inline: true },
        { name: 'To (Recipient)', value: `\`${toShort}\``, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    if (forwardInfo.txHash) {
      discordEmbed.fields.push({
        name: 'Transaction',
        value: forwardInfo.explorerUrl ? `[View on Explorer](${forwardInfo.explorerUrl}/tx/${forwardInfo.txHash})` : `\`${forwardInfo.txHash}\``,
        inline: false
      });
    }

    const tgText = `
<b>🔄 NFT Forwarded</b>
<b>Token ID:</b> #${escapeHtml(forwardInfo.tokenId)}
<b>From:</b> <code>${escapeHtml(fromShort)}</code>
<b>To:</b> <code>${escapeHtml(toShort)}</code>
${forwardInfo.txHash ? `<b>Tx:</b> <a href="${escapeHtml(txLink)}">View Transaction</a>` : ''}
`.trim();

    await Promise.allSettled([
      this.sendDiscord(discordEmbed),
      this.sendTelegram(tgText)
    ]);
  },

  /**
   * Send a copy-mint execution summary alert
   * @param {object} report
   */
  async sendCopyMintAlert(report) {
    const isSuccess = report.submittedCount > 0;
    const targetShort = `${report.targetContract.slice(0, 6)}...${report.targetContract.slice(-4)}`;
    const whaleShort = report.whaleWallet ? `${report.whaleWallet.slice(0, 6)}...${report.whaleWallet.slice(-4)}` : 'Manual';

    const discordEmbed = {
      title: isSuccess ? '🚀 Whale Copy-Mint Executed!' : '❌ Copy-Mint Failed',
      color: isSuccess ? 0x00E5FF : 0xFF3366,
      fields: [
        { name: 'Whale', value: `\`${report.whaleLabel || whaleShort}\``, inline: true },
        { name: 'Target Contract', value: `\`${targetShort}\``, inline: true },
        { name: 'Cost per Token', value: `${report.costEth} ETH (${report.paymentMode})`, inline: true },
        { name: 'Wallets Submitted', value: `${report.submittedCount}/${report.totalWallets}`, inline: true },
        { name: 'Execution Latency', value: `${report.durationMs}ms`, inline: true }
      ],
      timestamp: new Date().toISOString()
    };

    const tgText = `
<b>${isSuccess ? '🚀 Whale Copy-Mint Executed!' : '❌ Copy-Mint Failed'}</b>
━━━━━━━━━━━━━━━━━━━━
🎯 <b>Whale:</b> <code>${escapeHtml(report.whaleLabel || whaleShort)}</code>
📄 <b>Contract:</b> <code>${escapeHtml(report.targetContract)}</code>
💰 <b>Cost:</b> <code>${escapeHtml(report.costEth)} ETH</code> (${escapeHtml(report.paymentMode)})
⚡ <b>Wallets Submitted:</b> <code>${report.submittedCount}/${report.totalWallets}</code>
⏱ <b>Latency:</b> <code>${report.durationMs}ms</code>
━━━━━━━━━━━━━━━━━━━━
`.trim();

    await Promise.allSettled([
      this.sendDiscord(discordEmbed),
      this.sendTelegram(tgText)
    ]);
  }
};

module.exports = Notifier;

