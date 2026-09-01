/**
 * PnL Card Generator — Renders 1200x675 HD PnL Trading Cards with Collection Image & Whale Alpha.
 *
 * Supports:
 * - High-res SVG vector card generation (1200x675) matching custom user template design
 * - Ambient warm copper/amber glow with glassmorphic dark container
 * - Formatted Telegram rich visual card & HTML messages
 * - Terminal ANSI PnL Dashboard rendering
 */

const fs = require('fs');
const path = require('path');

class PnLCardGenerator {
  /**
   * Generate a 1200x675 Dark-Mode SVG Trading Card matching the exact user template
   * @param {object} pnlData
   * @returns {string} SVG code string
   */
  static generateSvgCard(pnlData) {
    const isProfitable = (pnlData.netProfitUsd || 0) >= 0;
    const profitSign = isProfitable ? '+' : '';
    const profitFormatted = isProfitable
      ? `$${Math.round(pnlData.netProfitUsd || 10000)}`
      : `-$${Math.abs(Math.round(pnlData.netProfitUsd || 0))}`;

    const topColl = pnlData.topCollections && pnlData.topCollections.length > 0
      ? pnlData.topCollections[0]
      : {
          collectionName: 'Robinhood Genesis Drop',
          contractAddress: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
          whaleLabel: 'Alpha Whale',
          unitPriceEth: '0.002eth',
          chain: 'Rh',
          totalWallets: pnlData.totalWallets || 100,
          totalMinted: pnlData.totalMinted || 100
        };

    const collName = topColl.collectionName || 'Collection name';
    const contractShort = topColl.contractAddress
      ? `${topColl.contractAddress.slice(0, 8)}...${topColl.contractAddress.slice(-6)}`
      : 'Collection Contract';
    const chainName = topColl.chain || 'Rh';
    const walletsCount = topColl.totalWallets || pnlData.totalWallets || 100;
    const mintedCount = topColl.totalMinted || pnlData.totalMinted || 100;
    const priceFormatted = topColl.unitPriceEth || `${pnlData.totalCostEth || '0.002'}eth`;
    const dateStr = new Date().toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }) + ' UTC';

    // 1200x675 Custom Template SVG Card
    return `
<svg width="1200" height="675" viewBox="0 0 1200 675" fill="none" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <!-- Background Base Gradient -->
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1200" y2="675" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#080705" />
      <stop offset="50%" stop-color="#0D0B08" />
      <stop offset="100%" stop-color="#050403" />
    </linearGradient>

    <!-- Ambient Copper/Amber Glows -->
    <radialGradient id="glowBottomLeft" cx="0" cy="1" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(0 675) scale(600 600)">
      <stop offset="0%" stop-color="#E66700" stop-opacity="0.45" />
      <stop offset="50%" stop-color="#B84800" stop-opacity="0.15" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <radialGradient id="glowTopRight" cx="1" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(1200 0) scale(750 750)">
      <stop offset="0%" stop-color="#E66700" stop-opacity="0.40" />
      <stop offset="50%" stop-color="#943800" stop-opacity="0.12" />
      <stop offset="100%" stop-color="#000000" stop-opacity="0" />
    </radialGradient>

    <!-- Glassmorphic Card Surface -->
    <linearGradient id="cardBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1A1714" stop-opacity="0.92" />
      <stop offset="100%" stop-color="#12100E" stop-opacity="0.94" />
    </linearGradient>

    <linearGradient id="cardBorder" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.22" />
      <stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.08" />
      <stop offset="100%" stop-color="#E66700" stop-opacity="0.30" />
    </linearGradient>

    <!-- Drop Shadow Filter -->
    <filter id="cardShadow" x="40" y="40" width="640" height="600" filterUnits="userSpaceOnUse">
      <feDropShadow dx="0" dy="24" stdDeviation="36" flood-color="#000000" flood-opacity="0.75" />
    </filter>
  </defs>

  <style>
    .font-title { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif; font-weight: 700; }
    .font-mono { font-family: 'SF Mono', 'Roboto Mono', Menlo, Consolas, monospace; }
    .font-body { font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', Roboto, sans-serif; font-weight: 400; }
  </style>

  <!-- Background Canvas -->
  <rect width="1200" height="675" fill="url(#bgGrad)" />

  <!-- Ambient Glow Effects -->
  <rect width="1200" height="675" fill="url(#glowBottomLeft)" />
  <rect width="1200" height="675" fill="url(#glowTopRight)" />

  <!-- Floating Glass Card Container -->
  <g filter="url(#cardShadow)">
    <rect x="85" y="70" width="550" height="535" rx="34" fill="url(#cardBg)" />
    <rect x="85" y="70" width="550" height="535" rx="34" stroke="url(#cardBorder)" stroke-width="1.5" />

    <!-- Top Section: Square Rounded Thumbnail & Info -->
    <!-- Thumbnail Frame -->
    <rect x="125" y="110" width="135" height="135" rx="26" fill="#0D0C0A" stroke="#2E2A24" stroke-width="1.5" />
    <rect x="131" y="116" width="123" height="123" rx="20" fill="#171512" />
    
    <!-- Thumbnail Placeholder Icon -->
    <circle cx="192" cy="165" r="24" fill="#E66700" fill-opacity="0.25" />
    <path d="M182 175 L192 155 L202 175 Z" fill="#E66700" />
    <circle cx="204" cy="150" r="4" fill="#FF8A24" />

    <!-- Collection Header Texts -->
    <text x="285" y="150" fill="#FFFFFF" class="font-title" font-size="28" letter-spacing="-0.5">${escapeXml(collName)}</text>
    <text x="285" y="180" fill="#E66700" class="font-mono" font-size="15" font-weight="600">${escapeXml(contractShort)}</text>
    <text x="285" y="210" fill="#7E7A73" class="font-body" font-size="14">${escapeXml(dateStr)}</text>

    <!-- Middle Section: 2x2 Stats Grid -->
    <!-- Row 1: Chain & Wallets -->
    <text x="125" y="295" fill="#FFFFFF" class="font-body" font-size="20">Chain</text>
    <text x="125" y="328" fill="#E66700" class="font-title" font-size="24">${escapeXml(chainName)}</text>

    <text x="310" y="295" fill="#FFFFFF" class="font-body" font-size="20">Wallets</text>
    <text x="310" y="328" fill="#E66700" class="font-title" font-size="24">${walletsCount}</text>

    <!-- Row 2: Minted & Price -->
    <text x="125" y="390" fill="#FFFFFF" class="font-body" font-size="20">Minted</text>
    <text x="125" y="423" fill="#E66700" class="font-title" font-size="24">${mintedCount}</text>

    <text x="310" y="390" fill="#FFFFFF" class="font-body" font-size="20">Price</text>
    <text x="310" y="423" fill="#E66700" class="font-title" font-size="24">${escapeXml(priceFormatted)}</text>

    <!-- Bottom Section: Profit Label & Huge Centered Amount -->
    <text x="125" y="490" fill="#FFFFFF" class="font-body" font-size="22">Profit</text>
    <text x="360" y="555" text-anchor="middle" fill="#FFFFFF" class="font-title" font-size="54" letter-spacing="-1">${profitFormatted}</text>
  </g>
</svg>
    `.trim();
  }

  /**
   * Format text message for Telegram with HTML & Image support
   */
  static formatTelegramMessage(pnlData) {
    const isProfitable = (pnlData.netProfitUsd || 0) >= 0;
    const profitSign = isProfitable ? '+' : '';
    const topColl = pnlData.topCollections && pnlData.topCollections.length > 0 ? pnlData.topCollections[0] : null;

    const lines = [
      `📊 <b>COPY-MINT PnL & PERFORMANCE REPORT</b>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `💰 <b>NET PROFIT:</b> <b>${profitSign}$${(pnlData.netProfitUsd || 0).toFixed(2)} (${profitSign}${pnlData.roiPct || 0}% ROI)</b> ${isProfitable ? '🟢' : '🔴'}`,
      `📈 <b>Net ETH:</b> <code>${profitSign}${pnlData.netProfitEth || '0.00'} ETH</code>`,
      `━━━━━━━━━━━━━━━━━━━━`,
      `📦 <b>Total Minted:</b> <code>${pnlData.totalMinted || 0} NFTs</code> (${pnlData.totalDrops || 1} drops)`,
      `🏷️ <b>Total Spent:</b> <code>$${(pnlData.totalCostUsd || 0).toFixed(2)}</code> (${pnlData.totalCostEth || '0.00'} ETH incl. gas)`,
      `💸 <b>Total Sold:</b> <code>${pnlData.totalSold || 0} NFTs</code> (Rev: <code>$${(pnlData.totalRevenueUsd || 0).toFixed(2)}</code>)`,
      `💼 <b>Unsold Holdings:</b> <code>${pnlData.holdingCount || 0} NFTs</code> (Floor Val: <code>$${(pnlData.unrealizedFloorUsd || 0).toFixed(2)}</code>)`,
      `━━━━━━━━━━━━━━━━━━━━`
    ];

    if (topColl) {
      lines.push(`<b>🏆 Collection:</b> <b>${topColl.collectionName || 'Drop'}</b>`);
      lines.push(`• <b>Whale Alpha:</b> <code>${topColl.whaleLabel || 'Tracked Whale'}</code>`);
      lines.push(`• <b>Profit:</b> <code>+${topColl.netProfitEth || '0.00'} ETH (+$${(topColl.netProfitUsd || 0).toFixed(2)})</code>`);
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    }

    if (pnlData.topWhales && pnlData.topWhales.length > 0) {
      lines.push(`<b>🐋 Top Whales Ranked by Profit:</b>`);
      pnlData.topWhales.slice(0, 3).forEach((w, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : '🥉';
        lines.push(`${medal} <b>${w.whaleLabel}:</b> ${w.dropsCount} drop(s) (${w.totalMinted} NFTs)`);
      });
      lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    }

    lines.push(`<i>Send /sweep to transfer unsold NFTs to cold storage.</i>`);
    return lines.join('\n');
  }

  /**
   * Save SVG Card to a file
   */
  static saveSvgCardToFile(pnlData, outputPath = null) {
    const svgCode = this.generateSvgCard(pnlData);
    const targetFile = outputPath || path.join(process.cwd(), 'data', 'latest_copymint_pnl.svg');
    const parentDir = path.dirname(targetFile);

    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(targetFile, svgCode, 'utf-8');
    return targetFile;
  }
}

function escapeXml(unsafe) {
  return String(unsafe || '')
    .replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case '\'': return '&apos;';
        case '"': return '&quot;';
      }
    });
}

module.exports = PnLCardGenerator;
