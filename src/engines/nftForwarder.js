const { Interface, Contract } = require('ethers');
const logger = require('../utils/logger');
const Notifier = require('../utils/notifier');

const ERC721_ABI = [
  'function safeTransferFrom(address from, address to, uint256 tokenId) external',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

const ERC1155_ABI = [
  'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data) external',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)'
];

/**
 * Forward minted NFTs from a single receipt (used by copy-mint and single-wallet tasks)
 * @param {object} params
 * @param {ethers.TransactionReceipt} params.receipt
 * @param {ethers.Wallet|ethers.Signer} params.signer
 * @param {string} params.recipientAddress
 * @param {ethers.Provider} [params.provider]
 * @param {string} [params.explorerUrl]
 */
async function forwardNftsFromReceipt({ receipt, signer, recipientAddress, provider, explorerUrl = '' }) {
  if (!recipientAddress || !recipientAddress.startsWith('0x') || !receipt || !receipt.logs) return [];

  const erc721Iface = new Interface(ERC721_ABI);
  const erc1155Iface = new Interface(ERC1155_ABI);
  const signerAddress = (signer.address || await signer.getAddress()).toLowerCase();
  const forwardedTokens = [];

  for (const log of receipt.logs) {
    // Check ERC-721 Transfer
    try {
      const parsed721 = erc721Iface.parseLog(log);
      if (parsed721 && parsed721.name === 'Transfer') {
        const tokenId = parsed721.args.tokenId.toString();
        const toAddress = (parsed721.args.to || '').toLowerCase();

        if (toAddress === signerAddress) {
          if (signerAddress === recipientAddress.toLowerCase()) {
            logger.info(`Token #${tokenId} is already in recipient wallet ${signerAddress.slice(0, 6)}... (skipping self-transfer)`);
            forwardedTokens.push({ standard: 'ERC721', tokenId, contractAddress: log.address, txHash: null });
            continue;
          }
          logger.info(`Forwarding ERC-721 Token #${tokenId} from ${signerAddress.slice(0, 6)}... to ${recipientAddress.slice(0, 6)}...`);
          try {
            const nftContract = new Contract(log.address, ERC721_ABI, signer);
            const tx = await nftContract.safeTransferFrom(signerAddress, recipientAddress, tokenId, { gasLimit: 120000 });
            logger.speed(`Forward Tx Sent: ${tx.hash}`);
            const forwardReceipt = await tx.wait(1, 30000);
            logger.success(`Token #${tokenId} forwarded! (Block: ${forwardReceipt.blockNumber})`);

            forwardedTokens.push({ standard: 'ERC721', tokenId, contractAddress: log.address, txHash: tx.hash });

            await Notifier.sendForwardAlert({
              tokenId,
              fromAddress: signerAddress,
              toAddress: recipientAddress,
              txHash: tx.hash,
              explorerUrl
            });
          } catch (txErr) {
            logger.warn(`[NFT Forwarder] Failed to forward ERC-721 Token #${tokenId}: ${txErr.message}`);
          }
        }
      }
    } catch (e) {}

    // Check ERC-1155 TransferSingle
    try {
      const parsed1155 = erc1155Iface.parseLog(log);
      if (parsed1155 && parsed1155.name === 'TransferSingle') {
        const tokenId = parsed1155.args.id.toString();
        const amount = parsed1155.args.value;
        const toAddress = (parsed1155.args.to || '').toLowerCase();

        if (toAddress === signerAddress) {
          if (signerAddress === recipientAddress.toLowerCase()) {
            logger.info(`ERC-1155 Token #${tokenId} is already in recipient wallet ${signerAddress.slice(0, 6)}... (skipping self-transfer)`);
            forwardedTokens.push({ standard: 'ERC1155', tokenId, amount, contractAddress: log.address, txHash: null });
            continue;
          }
          logger.info(`Forwarding ERC-1155 Token #${tokenId} (qty: ${amount}) to ${recipientAddress.slice(0, 6)}...`);
          try {
            const nftContract = new Contract(log.address, ERC1155_ABI, signer);
            const tx = await nftContract.safeTransferFrom(signerAddress, recipientAddress, tokenId, amount, '0x', { gasLimit: 120000 });
            logger.speed(`Forward Tx Sent: ${tx.hash}`);
            const forwardReceipt = await tx.wait(1, 30000);
            logger.success(`ERC-1155 Token #${tokenId} forwarded! (Block: ${forwardReceipt.blockNumber})`);

            forwardedTokens.push({ standard: 'ERC1155', tokenId, amount, contractAddress: log.address, txHash: tx.hash });

            await Notifier.sendForwardAlert({
              tokenId,
              fromAddress: signerAddress,
              toAddress: recipientAddress,
              txHash: tx.hash,
              explorerUrl
            });
          } catch (txErr) {
            logger.warn(`[NFT Forwarder] Failed to forward ERC-1155 Token #${tokenId}: ${txErr.message}`);
          }
        }
      }
    } catch (e) {}
  }

  return forwardedTokens;
}

/**
 * Forward minted NFTs to recipient address across batch mint results
 * @param {Array<object>} results 
 * @param {ethers.Wallet[]} wallets 
 * @param {ethers.Provider} provider 
 * @param {string} recipientAddress 
 * @param {string} explorerUrl 
 */
async function forwardNFTs(results, wallets, provider, recipientAddress, explorerUrl = '') {
  if (!recipientAddress || !recipientAddress.startsWith('0x')) return;

  logger.info(`Starting automatic NFT forwarding to: ${recipientAddress}`);

  const forwardPromises = results.map(async (result) => {
    try {
      const receipt = result.receipt || (result.txHash && provider ? await provider.getTransactionReceipt(result.txHash).catch(() => null) : null);
      if (!receipt || !receipt.logs) return;

      const targetAddress = (result.address || result.walletAddress || '').toLowerCase();
      const wallet = wallets.find(w => w.address.toLowerCase() === targetAddress) || result.wallet;
      if (!wallet) return;

      const connectedWallet = wallet.connect ? wallet.connect(provider) : wallet;

      await forwardNftsFromReceipt({
        receipt,
        signer: connectedWallet,
        recipientAddress,
        provider,
        explorerUrl
      });
    } catch (error) {
      logger.error(`Error forwarding NFT for wallet: ${error.message}`);
    }
  });

  await Promise.allSettled(forwardPromises);
  logger.success('NFT forwarding phase completed.');
}

module.exports = { forwardNFTs, forwardNftsFromReceipt };
