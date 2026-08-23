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
      head: [chalk.cyan('Wallet'), chalk.cyan('Status'), chalk.cyan('Tx Hash'), chalk.cyan('Speed'), chalk.cyan('Details')],
      colWidths: [18, 15, 20, 12, 28]
    });

    for (const res of results) {
      const truncatedAddr = `${res.address.slice(0, 6)}...${res.address.slice(-4)}`;
      const truncatedTx = res.txHash ? `${res.txHash.slice(0, 8)}...${res.txHash.slice(-6)}` : 'N/A';
      
      let statusStr = res.status;
      if (res.status === 'SUCCESS') statusStr = chalk.green(res.status);
      else if (res.status === 'FAILED') statusStr = chalk.red(res.status);

      let speedStr = chalk.gray('—');
      if (res.mintDurationMs != null) {
        const ms = res.mintDurationMs;
        if (ms < 1000) {
          speedStr = chalk.green(`${ms}ms`);
        } else {
          speedStr = chalk.yellow(`${(ms / 1000).toFixed(2)}s`);
        }
      }
      
      table.push([
        truncatedAddr,
        statusStr,
        truncatedTx,
        speedStr,
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
   * Deadline-based countdown that supports sub-second waits without overshooting.
   */
  preciseCountdown(seconds) {
    return new Promise(resolve => {
      const totalMs = Math.max(0, Math.ceil(Number(seconds || 0) * 1000));
      if (!Number.isFinite(totalMs) || totalMs <= 0) {
        process.stdout.write('\r\n');
        resolve();
        return;
      }

      const deadline = Date.now() + totalMs;

      const tick = () => {
        const remainingMs = Math.max(0, deadline - Date.now());
        const display = remainingMs <= 10000
          ? (remainingMs / 1000).toFixed(1)
          : Math.ceil(remainingMs / 1000).toString();

        process.stdout.write(`\r${chalk.blue('[timer]')} Starting in ${chalk.yellow(display)} seconds...  `);

        if (remainingMs <= 0) {
          process.stdout.write('\r\n');
          resolve();
          return;
        }

        setTimeout(tick, Math.min(remainingMs, remainingMs <= 10000 ? 100 : 1000));
      };

      tick();
    });
  },

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
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
   * Prints a speed performance report after minting completes
   * @param {Array} results Array of mint results with mintDurationMs
   * @param {number} totalSessionMs Total session duration from FIRE to last receipt
   */
  speedReport(results, totalSessionMs) {
    const successResults = results.filter(r => r.status === 'SUCCESS' && r.mintDurationMs != null);

    if (successResults.length === 0) {
      console.log(chalk.gray('  No successful mints to report speed for.'));
      return;
    }

    const durations = successResults.map(r => r.mintDurationMs);
    const fastest = Math.min(...durations);
    const slowest = Math.max(...durations);
    const average = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);

    console.log(chalk.magenta('⚡') + chalk.bold(' SPEED REPORT'));
    console.log(chalk.gray('  ─────────────────────────────────────'));

    const speedTable = new Table({
      head: [chalk.magenta('Metric'), chalk.magenta('Value')],
      colWidths: [30, 25],
      style: { head: [], border: [] }
    });

    speedTable.push(
      [chalk.cyan('Fastest Mint'), chalk.green(`${fastest < 1000 ? fastest + 'ms' : (fastest / 1000).toFixed(2) + 's'}`)],
      [chalk.cyan('Slowest Mint'), chalk.yellow(`${slowest < 1000 ? slowest + 'ms' : (slowest / 1000).toFixed(2) + 's'}`)],
      [chalk.cyan('Average Mint Speed'), chalk.white(`${average < 1000 ? average + 'ms' : (average / 1000).toFixed(2) + 's'}`)],
      [chalk.cyan('Total Session Duration'), chalk.white(`${totalSessionMs < 1000 ? totalSessionMs + 'ms' : (totalSessionMs / 1000).toFixed(2) + 's'}`)],
      [chalk.cyan('Successful Mints'), chalk.green(`${successResults.length}`)],
      [chalk.cyan('Mints Per Second'), chalk.white(`${(successResults.length / (totalSessionMs / 1000)).toFixed(2)}`)]
    );

    console.log(speedTable.toString());
    console.log('');
  },

  /**
   * Horizontal separator line
   */
  separator() {
    console.log(chalk.gray('------------------------------------------------------------'));
  }
};

module.exports = logger;
