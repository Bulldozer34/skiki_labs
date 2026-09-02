#!/usr/bin/env node
/**
 * NFT Mint Bot Main Entry Point
 * Runs the 24/7 background daemon by default (for PM2 and cloud VPS),
 * or runs the interactive CLI wizard if invoked with --cli.
 */

if (process.argv.includes('--cli')) {
  require('./cli.js');
} else {
  require('./daemon.js');
}
