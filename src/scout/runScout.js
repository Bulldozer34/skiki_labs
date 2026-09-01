/**
 * CLI Runner for Robinhood NFT Copy-Mint Discovery & Watchlist Generator
 */

const fs = require('fs');
const path = require('path');
const RobinhoodScout = require('./robinhoodScout');
const Table = require('cli-table3');
const chalk = require('chalk');
require('dotenv').config();

async function main() {
  console.log(chalk.bold.cyan('\n======================================================'));
  console.log(chalk.bold.cyan('   🦅 ROBINHOOD CHAIN NFT COPY-MINT WHALE SCOUT 🦅   '));
  console.log(chalk.bold.cyan('======================================================\n'));

  // Allow custom blocks lookback or default to 30,000 blocks (~3-5 days of high-frequency data)
  const args = process.argv.slice(2);
  let lookback = 30000;
  const lbIndex = args.indexOf('--blocks');
  if (lbIndex !== -1 && args[lbIndex + 1]) {
    lookback = parseInt(args[lbIndex + 1], 10);
  }

  const scout = new RobinhoodScout({
    maxMintCostUSD: 0.50,
    minDistinctDrops: 2,
    apiKey: process.env.OPENSEA_API_KEY
  });

  const rankedWallets = await scout.runAnalysis(lookback);

  if (rankedWallets.length === 0) {
    console.log(chalk.yellow('\nNo wallets met the strict multi-drop criteria in this block range.'));
    return;
  }

  // Display top 10 in a formatted table
  const table = new Table({
    head: [
      chalk.bold('Rank'),
      chalk.bold('Wallet Address'),
      chalk.bold('Alpha Score'),
      chalk.bold('Win Rate'),
      chalk.bold('Net Profit'),
      chalk.bold('Drops Minted'),
      chalk.bold('Profitable Drops')
    ],
    colWidths: [6, 44, 13, 11, 14, 15, 18]
  });

  const top10 = rankedWallets.slice(0, 10);
  top10.forEach((w, idx) => {
    table.push([
      `#${idx + 1}`,
      chalk.green(w.address),
      chalk.bold.yellow(w.alphaScore),
      `${w.winRatePercent}%`,
      chalk.cyan(`+$${w.netTotalProfitUSD.toFixed(2)}`),
      w.distinctDropsCount,
      w.profitableDropsCount
    ]);
  });

  console.log('\n' + table.toString() + '\n');

  // Save to data/copy_mint_watchlist.json
  const dataDir = path.join(__dirname, '../../data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const watchlistPayload = {
    generatedAt: new Date().toISOString(),
    network: 'Robinhood Chain (4663)',
    criteria: 'Mint Price <= $0.50 / Free, Multi-Drop Verified, Anti-Scam Filtered',
    totalScouted: rankedWallets.length,
    wallets: rankedWallets.map(w => ({
      address: w.address,
      alphaScore: w.alphaScore,
      winRatePercent: w.winRatePercent,
      netTotalProfitUSD: w.netTotalProfitUSD,
      distinctDropsCount: w.distinctDropsCount,
      profitableDropsCount: w.profitableDropsCount,
      qualifyingDrops: w.contractDetails
    }))
  };

  const jsonPath = path.join(dataDir, 'copy_mint_watchlist.json');
  fs.writeFileSync(jsonPath, JSON.stringify(watchlistPayload, null, 2));
  console.log(chalk.green(`[✓] Watchlist exported to: ${jsonPath}`));

  // Generate ROBINHOOD_WHALE_LEADERBOARD.md
  let mdContent = `# 🦅 Robinhood Chain NFT Copy-Mint Whale Leaderboard\n\n`;
  mdContent += `**Generated**: ${new Date().toUTCString()}\n`;
  mdContent += `**Network**: Robinhood Chain (Chain ID: \`4663\`)\n`;
  mdContent += `**Filter Criteria**: Mint Cost $\\le \\$0.50$ / Free Mints | Anti-Wash Trading | Multi-Drop Verified ($\\ge 2$ drops) | No Insider Deployers\n\n`;
  mdContent += `## 🏆 Top Alpha Wallets for Copy-Minting\n\n`;
  mdContent += `| Rank | Wallet Address | Alpha Score | Win Rate | Net Total Profit | Mints | Profitable Drops | Explorer Link |\n`;
  mdContent += `|---|---|---|---|---|---|---|---|\n`;

  rankedWallets.slice(0, 25).forEach((w, idx) => {
    const explorer = `[Blockscout](https://robinhoodchain.blockscout.com/address/${w.address})`;
    mdContent += `| **#${idx + 1}** | \`${w.address}\` | **${w.alphaScore}** | **${w.winRatePercent}%** | **+$${w.netTotalProfitUSD.toFixed(2)}** | ${w.totalMintCount} | ${w.profitableDropsCount} / ${w.distinctDropsCount} | ${explorer} |\n`;
  });

  mdContent += `\n## 📊 Collection Activity Breakdown\n\n`;
  rankedWallets.slice(0, 10).forEach((w, idx) => {
    mdContent += `### #${idx + 1} \`${w.address}\`\n`;
    mdContent += `- **Win Rate**: ${w.winRatePercent}%\n`;
    mdContent += `- **Net Profit**: +$${w.netTotalProfitUSD.toFixed(2)} (Realized: +$${w.netRealizedProfitUSD.toFixed(2)}, Floor Holding: $${w.unrealizedFloorValueUSD.toFixed(2)})\n`;
    mdContent += `- **Minted Collections**:\n`;
    w.contractDetails.forEach(c => {
      mdContent += `  - **${c.name}** (\`${c.contract}\`)\n`;
    });
    mdContent += `\n`;
  });

  const mdPath = path.join(__dirname, '../../ROBINHOOD_WHALE_LEADERBOARD.md');
  fs.writeFileSync(mdPath, mdContent);
  console.log(chalk.green(`[✓] Markdown leaderboard generated: ${mdPath}\n`));
}

if (require.main === module) {
  main().catch(err => {
    console.error('Error running scout:', err);
    process.exit(1);
  });
}
