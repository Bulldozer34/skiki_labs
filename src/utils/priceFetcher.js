const axios = require('axios');

// In-memory price cache with 30-second TTL
let cachedEthPrice = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 30000; // 30 seconds

/**
 * Fetch live ETH price in USD with concurrent fast racing and in-memory TTL caching.
 * @param {boolean} [forceRefresh=false] - Bypass cache if true
 * @returns {Promise<number|null>} Price in USD, or null if all APIs fail
 */
async function getEthPriceUsd(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedEthPrice && now < cacheExpiry) {
    return cachedEthPrice;
  }

  const commonHeaders = {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // Define price fetching promises for concurrent execution
  const fetchers = [
    // 1. Binance
    axios.get('https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT', { timeout: 4000, headers: commonHeaders })
      .then(res => {
        const p = parseFloat(res.data?.price);
        if (!isNaN(p) && p > 0) return p;
        throw new Error('Invalid Binance price');
      }),

    // 2. CoinGecko
    axios.get('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      timeout: 4000,
      headers: commonHeaders
    }).then(res => {
      const p = Number(res.data?.ethereum?.usd);
      if (!isNaN(p) && p > 0) return p;
      throw new Error('Invalid CoinGecko price');
    }),

    // 3. CryptoCompare
    axios.get('https://min-api.cryptocompare.com/data/price?fsym=ETH&tsyms=USD', { timeout: 4000, headers: commonHeaders })
      .then(res => {
        const p = Number(res.data?.USD);
        if (!isNaN(p) && p > 0) return p;
        throw new Error('Invalid CryptoCompare price');
      }),

    // 4. Coinbase public ticker
    axios.get('https://api.coinbase.com/v2/prices/ETH-USD/spot', { timeout: 4000, headers: commonHeaders })
      .then(res => {
        const p = parseFloat(res.data?.data?.amount);
        if (!isNaN(p) && p > 0) return p;
        throw new Error('Invalid Coinbase price');
      })
  ];

  try {
    // Race all 4 endpoints concurrently using Promise.any — the fastest valid response wins!
    const fastestPrice = await Promise.any(fetchers);
    cachedEthPrice = fastestPrice;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return fastestPrice;
  } catch {
    // If all concurrent requests failed, return previously cached price or safe default fallback
    const fallbackPrice = cachedEthPrice || parseFloat(process.env.DEFAULT_ETH_PRICE || '2500');
    cachedEthPrice = fallbackPrice;
    cacheExpiry = Date.now() + CACHE_TTL_MS;
    return fallbackPrice;
  }
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
