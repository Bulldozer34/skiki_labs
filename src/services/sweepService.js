const { ethers } = require('ethers');
const MintTracker = require('../core/mintTracker');
const logger = require('../utils/logger');

const ERC721_ABI = [
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function name() view returns (string)',
  'function symbol() view returns (string)'
];

class SweepService {
  /**
   * Scan loaded burner wallets for owned NFTs
   * @param {ethers.Wallet[]} wallets
   * @param {ethers.JsonRpcProvider} provider
   * @returns {Promise<Array<{contract: string, name: string, tokenId: string, walletAddress: string, walletIndex: number}>>}
   */
  static async scanBurnerNfts(wallets, provider) {
    if (!wallets || wallets.length === 0) return [];

    const walletAddresses = new Set(wallets.map(w => w.address.toLowerCase()));
    const history = MintTracker.loadHistory();
    const candidates = []; // { contract, tokenId, walletAddress }

    // 1. Gather all potential token IDs and contracts from mint-history.json
    for (const m of history) {
      const contract = m.contractAddress;
      if (!contract || !contract.startsWith('0x') || contract.length !== 42) continue;

      if (m.tokenIds && Array.isArray(m.tokenIds)) {
        for (const tId of m.tokenIds) {
          candidates.push({ contract, tokenId: tId, walletAddress: m.walletAddress });
        }
      }
    }

    // Deduplicate candidate token keys
    const uniqueCandidates = [];
    const verifiedKeys = new Set();
    for (const item of candidates) {
      const key = `${item.contract.toLowerCase()}_${item.tokenId}`;
      if (!verifiedKeys.has(key)) {
        verifiedKeys.add(key);
        uniqueCandidates.push(item);
      }
    }

    // 2. Verify on-chain current ownership in parallel across all candidates
    const verificationResults = await Promise.allSettled(
      uniqueCandidates.map(async (item) => {
        try {
          const contract = new ethers.Contract(item.contract, ERC721_ABI, provider);
          const currentOwner = await contract.ownerOf(item.tokenId).catch(() => null);

          if (currentOwner && walletAddresses.has(currentOwner.toLowerCase())) {
            let colName = 'NFT Collection';
            try {
              colName = await contract.name().catch(() => 'NFT');
            } catch (e) {}

            const wIdx = wallets.findIndex(w => w.address.toLowerCase() === currentOwner.toLowerCase());

            return {
              contract: item.contract,
              name: colName,
              tokenId: item.tokenId,
              walletAddress: currentOwner,
              walletIndex: wIdx
            };
          }
        } catch (err) {
          // Token doesn't exist or revert
        }
        return null;
      })
    );

    const ownedNfts = verificationResults
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    return ownedNfts;
  }

  /**
   * Transfer selected NFTs to recipient
   * @param {ethers.Wallet[]} wallets Loaded wallets
   * @param {string} recipientAddress Target cold/hot wallet address
   * @param {Array<{contract: string, tokenId: string, walletAddress: string}>} items Items to transfer
   * @param {ethers.JsonRpcProvider} provider
   */
  static async transferNfts(wallets, recipientAddress, items, provider) {
    if (!items || items.length === 0) return [];

    const results = [];

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const wallet = wallets.find(w => w.address.toLowerCase() === item.walletAddress.toLowerCase());

      if (!wallet) {
        results.push({ ...item, status: 'FAILED', error: 'Owning wallet not found in session' });
        continue;
      }

      try {
        const connectedWallet = wallet.connect(provider);
        const contract = new ethers.Contract(item.contract, ERC721_ABI, connectedWallet);

        logger.info(`[Sweep] Transferring Token #${item.tokenId} from ${wallet.address.slice(0, 6)}... to ${recipientAddress.slice(0, 6)}...`);
        const tx = await contract.safeTransferFrom(wallet.address, recipientAddress, item.tokenId);
        const receipt = await tx.wait(1);

        results.push({
          ...item,
          status: 'SUCCESS',
          txHash: tx.hash,
          blockNumber: Number(receipt.blockNumber)
        });
      } catch (err) {
        logger.error(`[Sweep] Failed to transfer #${item.tokenId}: ${err.message}`);
        results.push({
          ...item,
          status: 'FAILED',
          error: err.reason || err.message
        });
      }
    }

    return results;
  }

  /**
   * Drain remaining ETH balance from all burner wallets to recipient
   * @param {ethers.Wallet[]} wallets
   * @param {string} recipientAddress
   * @param {ethers.JsonRpcProvider} provider
   */
  static async drainEth(wallets, recipientAddress, provider) {
    if (!wallets || wallets.length === 0) return [];

    const results = [];
    const feeData = await provider.getFeeData().catch(() => ({ gasPrice: ethers.parseUnits('0.1', 'gwei') }));
    const gasPrice = feeData.gasPrice || ethers.parseUnits('0.1', 'gwei');
    const gasLimit = 21000n;
    const transferCostWei = gasLimit * gasPrice;

    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];
      if (wallet.address.toLowerCase() === recipientAddress.toLowerCase()) continue;

      try {
        const balance = await provider.getBalance(wallet.address);
        if (balance <= transferCostWei) {
          results.push({
            address: wallet.address,
            status: 'SKIPPED',
            amountEth: '0.000',
            details: 'Balance too low to cover gas fee'
          });
          continue;
        }

        const amountToSendWei = balance - transferCostWei;
        const amountEthStr = ethers.formatEther(amountToSendWei);
        const connectedWallet = wallet.connect(provider);

        const tx = await connectedWallet.sendTransaction({
          to: recipientAddress,
          value: amountToSendWei,
          gasLimit: gasLimit,
          gasPrice: gasPrice
        });

        const receipt = await tx.wait(1);

        results.push({
          address: wallet.address,
          status: 'SUCCESS',
          amountEth: parseFloat(amountEthStr).toFixed(5),
          txHash: tx.hash,
          blockNumber: Number(receipt.blockNumber)
        });
      } catch (err) {
        results.push({
          address: wallet.address,
          status: 'FAILED',
          error: err.reason || err.message
        });
      }
    }

    return results;
  }
}

module.exports = SweepService;
