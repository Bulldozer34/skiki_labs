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
 * Forward minted NFTs to recipient address
 * @param {Array<{receipt: ethers.TransactionReceipt, wallet: ethers.Wallet}>} results 
 * @param {ethers.Wallet[]} wallets 
 * @param {ethers.Provider} provider 
 * @param {string} recipientAddress 
 * @param {string} explorerUrl 
 */
async function forwardNFTs(results, wallets, provider, recipientAddress, explorerUrl = '') {
  if (!recipientAddress || !recipientAddress.startsWith('0x')) return;

  const erc721Iface = new Interface(ERC721_ABI);
  const erc1155Iface = new Interface(ERC1155_ABI);
  
  logger.info(`Starting automatic NFT forwarding to: ${recipientAddress}`);

  const forwardPromises = results.map(async (result) => {
    try {
      const { receipt, wallet } = result;
      if (!receipt || !receipt.logs) return;

      const connectedWallet = wallet.connect ? wallet.connect(provider) : wallet;

      for (const log of receipt.logs) {
        // Try ERC-721 Transfer event
        try {
          const parsed721 = erc721Iface.parseLog(log);
          if (parsed721 && parsed721.name === 'Transfer') {
            const tokenId = parsed721.args.tokenId.toString();
            const nftContractAddress = log.address; // The actual NFT token contract
            
            // Only forward if the token was transferred to our wallet
            if (parsed721.args.to.toLowerCase() === wallet.address.toLowerCase()) {
              logger.info(`Forwarding ERC-721 Token #${tokenId} from ${wallet.address.slice(0, 6)}... to ${recipientAddress.slice(0, 6)}...`);
              const nftContract = new Contract(nftContractAddress, ERC721_ABI, connectedWallet);
              const tx = await nftContract.safeTransferFrom(wallet.address, recipientAddress, tokenId);
              logger.speed(`Forward Tx Sent: ${tx.hash}`);
              const forwardReceipt = await tx.wait(1, 45000);
              logger.success(`Token #${tokenId} forwarded! (Block: ${forwardReceipt.blockNumber})`);

              // Trigger webhook notification
              await Notifier.sendForwardAlert({
                tokenId,
                fromAddress: wallet.address,
                toAddress: recipientAddress,
                txHash: tx.hash,
                explorerUrl
              });
            }
          }
        } catch (e) {
          // Not ERC-721
        }

        // Try ERC-1155 TransferSingle event
        try {
          const parsed1155 = erc1155Iface.parseLog(log);
          if (parsed1155 && parsed1155.name === 'TransferSingle') {
            const tokenId = parsed1155.args.id.toString();
            const amount = parsed1155.args.value;
            const nftContractAddress = log.address;

            if (parsed1155.args.to.toLowerCase() === wallet.address.toLowerCase()) {
              logger.info(`Forwarding ERC-1155 Token #${tokenId} (qty: ${amount}) to ${recipientAddress.slice(0, 6)}...`);
              const nftContract = new Contract(nftContractAddress, ERC1155_ABI, connectedWallet);
              const tx = await nftContract.safeTransferFrom(wallet.address, recipientAddress, tokenId, amount, '0x');
              logger.speed(`Forward Tx Sent: ${tx.hash}`);
              const forwardReceipt = await tx.wait(1, 45000);
              logger.success(`ERC-1155 Token #${tokenId} forwarded! (Block: ${forwardReceipt.blockNumber})`);

              // Trigger webhook notification
              await Notifier.sendForwardAlert({
                tokenId,
                fromAddress: wallet.address,
                toAddress: recipientAddress,
                txHash: tx.hash,
                explorerUrl
              });
            }
          }
        } catch (e) {
          // Not ERC-1155
        }
      }
    } catch (error) {
      logger.error(`Error forwarding NFT for wallet: ${error.message}`);
    }
  });

  await Promise.allSettled(forwardPromises);
  logger.success('NFT forwarding phase completed.');
}

module.exports = { forwardNFTs };
