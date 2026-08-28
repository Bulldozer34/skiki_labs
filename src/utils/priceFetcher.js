const axios = require('axios');

/**
 * Fetch live ETH price in USD using multiple fallback APIs
 * @returns {Promise<number|null>} Price in USD, or null if all APIs fail
 */
async function getEthPriceUsd() {
  // 1. Try CoinGecko
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      timeout: 4000,
      headers: { 'Accept': 'application/json' }
    });
    if (res.data?.ethereum?.usd) {
      return Number(res.data.ethereum.usd);
    }
  } catch (e) {
    // Continue to next fallback
  }

  // 2. Try Binance
  try {
    const res = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', {
      timeout: 4000
    });
    if (res.data?.price) {
      return parseFloat(res.data.price);
    }
  } catch (e) {
    // Continue to next fallback
  }

  // 3. Try CryptoCompare
  try {
    const res = await axios.get('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD', {
      timeout: 4000
    });
    if (res.data?.USD) {
      return Number(res.data.USD);
    }
  } catch (e) {
    // All fallbacks failed
  }

  return null;
}

/**
 * Convert USD to ETH (returns string formatted to 6 decimal places)
 * @param {number} usdAmount 
 * @param {number} ethPriceUsd 
 * @returns {string}
 */
function convertUsdToEth(usdAmount, ethPriceUsd) {
  if (!ethPriceUsd || ethPriceUsd <= 0) return '0';
  const eth = Number(usdAmount) / ethPriceUsd;
  return eth.toFixed(6);
}

/**
 * Convert ETH to USD (returns string formatted to 2 decimal places)
 * @param {number|string} ethAmount 
 * @param {number} ethPriceUsd 
 * @returns {string}
 */
function convertEthToUsd(ethAmount, ethPriceUsd) {
  if (!ethPriceUsd || ethPriceUsd <= 0) return '0.00';
  const usd = Number(ethAmount) * ethPriceUsd;
  return usd.toFixed(2);
}

module.exports = {
  getEthPriceUsd,
  convertUsdToEth,
  convertEthToUsd
};
