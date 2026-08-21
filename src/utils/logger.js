const chalk = require('chalk');
const Table = require('cli-table3');

/**
 * Logger utility for colored CLI output
 */
const logger = {
  /**
   * Prints ASCII art banner
   */
  banner() {
    console.log(chalk.cyan(`
███╗   ██╗███████╗████████╗    ███╗   ███╗██╗███╗   ██╗████████╗    ██████╗  ██████╗ ████████╗
████╗  ██║██╔════╝╚══██╔══╝    ████╗ ████║██║████╗  ██║╚══██╔══╝    ██╔══██╗██╔═══██╗╚══██╔══╝
██╔██╗ ██║█████╗     ██║       ██╔████╔██║██║██╔██╗ ██║   ██║       ██████╔╝██║   ██║   ██║   
██║╚██╗██║██╔══╝     ██║       ██║╚██╔╝██║██║██║╚██╗██║   ██║       ██╔══██╗██║   ██║   ██║   
██║ ╚████║██║        ██║       ██║ ╚═╝ ██║██║██║ ╚████║   ██║       ██████╔╝╚██████╔╝   ██║   
╚═╝  ╚═══╝╚═╝        ╚═╝       ╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝   ╚═╝       ╚═════╝  ╚═════╝    ╚═╝   
                                      v3.0 CLI Edition
`));
  },

  success(msg) {
    console.log(chalk.green('✔') + ' ' + msg);
  },

  error(msg) {
    console.log(chalk.red('✖') + ' ' + msg);
  },

  warn(msg) {
    console.log(chalk.yellow('⚠') + ' ' + msg);
  },

  info(msg) {
    console.log(chalk.cyan('ℹ') + ' ' + msg);
  },

  speed(msg) {
    console.log(chalk.magenta('⚡') + ' ' + msg);
  },

  timer(msg) {
    console.log(chalk.blue('⏱') + ' ' + msg);
  },

  /**
   * Format a wallet status line
   */
  walletLine(address, status, detail = '') {
    const truncated = `${address.slice(0, 6)}...${address.slice(-4)}`;
    let statusColored = status;
    
    if (status.toLowerCase().includes('success') || status.toLowerCase().includes('minted')) {
      statusColored = chalk.green(status);
    } else if (status.toLowerCase().includes('fail') || status.toLowerCase().includes('error')) {
      statusColored = chalk.red(status);
    } else if (status.toLowerCase().includes('wait') || status.toLowerCase().includes('pend')) {
      statusColored = chalk.yellow(status);
    } else {
      statusColored = chalk.cyan(status);
    }

    console.log(`[${chalk.gray(truncated)}] ${statusColored} ${detail ? `- ${detail}` : ''}`);
  },

  /**
   * Print a CLI table of mint results
   */
  summaryTable(results) {
    const table = new Table({
      head: [chalk.cyan('Wallet'), chalk.cyan('Status'), chalk.cyan('Tx Hash'), chalk.cyan('Details')],
      colWidths: [18, 15, 20, 30]
    });

    for (const res of results) {
      const truncatedAddr = `${res.address.slice(0, 6)}...${res.address.slice(-4)}`;
      const truncatedTx = res.txHash ? `${res.txHash.slice(0, 8)}...${res.txHash.slice(-6)}` : 'N/A';
      
      let statusStr = res.status;
      if (res.status === 'SUCCESS') statusStr = chalk.green(res.status);
      else if (res.status === 'FAILED') statusStr = chalk.red(res.status);
      
      table.push([
        truncatedAddr,
        statusStr,
        truncatedTx,
        res.details || ''
      ]);
    }

    console.log('\n' + table.toString() + '\n');
  },

  /**
   * Live updating countdown line
   */
  countdown(seconds) {
    return new Promise(resolve => {
      let current = seconds;
      const interval = setInterval(() => {
        process.stdout.write(`\r${chalk.blue('⏱')} Starting in ${chalk.yellow(current)} seconds...  `);
        if (current <= 0) {
          clearInterval(interval);
          process.stdout.write('\r\n');
          resolve();
        }
        current--;
      }, 1000);
    });
  },

  /**
   * Displays a live-updating minting progress bar
   * @param {number} completed Number of completed mints
   * @param {number} total Total number of mints
   * @param {number} successCount Number of successful mints
   * @param {number} failCount Number of failed mints
   */
  mintProgress(completed, total, successCount, failCount) {
    const width = 20;
    const filled = total > 0 ? Math.min(width, Math.max(0, Math.round((completed / total) * width))) : 0;
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    process.stdout.write(`\r${chalk.magenta('⚡')} Minting Progress: [${bar}] ${completed}/${total} | ${chalk.green('✔ ' + successCount)} ${chalk.red('✖ ' + failCount)}  `);
  },

  /**
   * Prints final mint summary line
   * @param {number} successCount Number of successful mints
   * @param {number} failCount Number of failed mints
   * @param {number} total Total number of mints
   */
  mintComplete(successCount, failCount, total) {
    console.log(`\n${chalk.green('🎉')} Mint Complete: ${chalk.green(successCount + '/' + total + ' successful')}${failCount > 0 ? ' | ' + chalk.red(failCount + '/' + total + ' failed') : ''}`);
  },

  /**
   * Prints gas estimate information
   * @param {string} estimateStr Formatted gas estimate string
   */
  gasEstimate(estimateStr) {
    console.log(chalk.blue('⛽') + ' Gas Estimate: ' + chalk.yellow(estimateStr));
  },

  /**
   * Horizontal separator line
   */
  separator() {
    console.log(chalk.gray('------------------------------------------------------------'));
  }
};

module.exports = logger;
