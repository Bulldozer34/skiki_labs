const axios = require('axios');
const logger = require('../utils/logger');
const { ethers } = require('ethers');
const crypto = require('crypto');

/**
 * OpenSea SIWE Authentication Service
 */
class AuthService {
  constructor() {
    this.sessions = new Map();
  }

  /**
   * Authenticate a single wallet using SIWE
   * @param {ethers.Wallet} wallet 
   */
  async authenticate(wallet) {
    try {
      const address = wallet.address.toLowerCase();
      
      const commonHeaders = {
        'Origin': 'https://opensea.io',
        'Referer': 'https://opensea.io/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'gzip, deflate, br'
      };

      // 1. Get Nonce
      const nonceRes = await axios.get('https://auth.opensea.io/auth/nonce', {
        headers: commonHeaders,
        timeout: 8000
      });
      const nonce = nonceRes.data.nonce;
      const issuedAt = new Date().toISOString();

      // 2. Build SIWE message EXACTLY as Zun described
      const domain = 'opensea.io';
      const statement = 'By signing, you are proving you own this wallet and logging in. This does not initiate a transaction or cost any fees.';
      const uri = 'https://opensea.io/'; // Trailing slash is critical

      const messageText = `${domain} wants you to sign in with your Ethereum account:\n${address}\n\n${statement}\n\nURI: ${uri}\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${issuedAt}`;

      // 3. Sign message
      const signature = await wallet.signMessage(messageText);

      // 4. Verify signature & payload (using cryptographically secure random device_id)
      const secureDeviceId = 'device_' + crypto.randomBytes(8).toString('hex');
      const verifyPayload = {
        message: {
          domain,
          address,
          statement,
          uri,
          version: "1",
          chainId: "1",
          nonce,
          issuedAt
        },
        signature,
        chain_arch: "EVM",
        connector_id: "injected",
        device_id: secureDeviceId
      };

      const verifyRes = await axios.post('https://auth.opensea.io/auth/verify', verifyPayload, {
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });

      // 5. Extract cookies and token
      const cookies = verifyRes.headers['set-cookie'] || [];
      const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
      
      const access_token = verifyRes.data.access_token || '';
      const refresh_token = verifyRes.data.refresh_token || '';

      const session = {
        cookies: cookieString,
        access_token,
        refresh_token,
        authenticatedAt: Date.now()
      };

      this.sessions.set(address, session);
      return session;

    } catch (error) {
      throw new Error(`Auth failed for ${wallet.address}: ${error.message}`);
    }
  }

  /**
   * Get stored session for an address
   * @param {string} address 
   */
  getSession(address) {
    return this.sessions.get(address.toLowerCase());
  }

  /**
   * Check if a session is authenticated and valid (3.5 days = 302400000 ms)
   * @param {string} address 
   */
  isAuthenticated(address) {
    const session = this.getSession(address);
    if (!session) return false;
    
    const maxAge = 3.5 * 24 * 60 * 60 * 1000;
    return (Date.now() - session.authenticatedAt) < maxAge;
  }

  /**
   * Get headers for authenticated requests (e.g. GraphQL)
   * @param {string} address 
   */
  getAuthHeaders(address) {
    const session = this.getSession(address);
    if (!session) return null;

    return {
      'Cookie': session.cookies,
      'x-app-id': 'os2-web',
      'Origin': 'https://opensea.io',
      'Referer': 'https://opensea.io/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    };
  }

  /**
   * Authenticate all wallets concurrently
   * @param {ethers.Wallet[]} wallets 
   */
  async authenticateAll(wallets) {
    logger.info(`Authenticating ${wallets.length} wallets...`);
    
    const results = await Promise.allSettled(
      wallets.map(w => this.authenticate(w))
    );

    let successCount = 0;
    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        successCount++;
        logger.walletLine(wallets[i].address, 'Auth Success');
      } else {
        logger.walletLine(wallets[i].address, 'Auth Failed', res.reason?.message || 'Unknown auth error');
      }
    });

    logger.info(`Successfully authenticated ${successCount}/${wallets.length} wallets.`);
    return results;
  }
}

// Export singleton
module.exports = new AuthService();
