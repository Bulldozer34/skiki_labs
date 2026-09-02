#!/usr/bin/env node
/**
 * NFT Mint Bot Main Entry Point
 * Runs the 24/7 background daemon by default (for PM2 and cloud VPS),
 * or runs the interactive CLI wizard if invoked with --cli.
 */

if (process.argv.includes('--cli')) {
  require('./cli.js');
} else {
  // If run without flags, check if TTY and start CLI or daemon
  if (process.stdout.isTTY && !process.env.PM2_USAGE && !process.env.DAEMON_MODE) {
    require('./cli.js');
  } else {
    require('./daemon.js');
  }
}
