const { Interface, Contract } = require('ethers');

/**
 * SeaDrop v1 / v2 minimal ABI for public drops
 */
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable',
  'function getPublicDrop(address nftContract) external view returns (tuple(uint256 mintPrice, uint256 startTime, uint256 endTime, uint256 maxTotalMintableByWallet, uint256 feeBps, bool restrictFeeRecipients))',
  'function getCreatorPayoutAddress(address nftContract) external view returns (address)',
  'function getAllowListMerkleRoot(address nftContract) external view returns (bytes32)'
];

/**
 * SeaDrop canonical CREATE2 deployment addresses
 */
const SEADROP_ADDRESSES = {
  ETHEREUM: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  SEPOLIA: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  ROBINHOOD: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  ROBINHOOD_TESTNET: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  BASE: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  ARBITRUM: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  OPTIMISM: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
};

/**
 * Read public drop parameters directly from SeaDrop contract on-chain
 * @param {ethers.Provider} provider 
 * @param {string} seadropAddress 
 * @param {string} nftContractAddress 
 * @returns {Promise<{mintPrice: bigint, startTime: bigint, endTime: bigint, maxMintable: bigint, feeRecipient: string}>}
 */
async function getPublicDropParams(provider, seadropAddress, nftContractAddress) {
  const seadropContract = new Contract(seadropAddress, SEADROP_ABI, provider);
  
  const [publicDrop, feeRecipient] = await Promise.all([
    seadropContract.getPublicDrop(nftContractAddress),
    seadropContract.getCreatorPayoutAddress(nftContractAddress).catch(() => '0x0000000000000000000000000000000000000000')
  ]);

  return {
    mintPrice: publicDrop.mintPrice,
    startTime: publicDrop.startTime,
    endTime: publicDrop.endTime,
    maxMintable: publicDrop.maxTotalMintableByWallet,
    feeBps: publicDrop.feeBps,
    feeRecipient
  };
}

/**
 * Encode calldata for mintPublic
 * @param {string} nftContract 
 * @param {string} feeRecipient 
 * @param {string} minter 
 * @param {number|string|bigint} quantity 
 * @returns {string} Encoded hex calldata
 */
function encodeMintPublicCalldata(nftContract, feeRecipient, minter, quantity) {
  const iface = new Interface(SEADROP_ABI);
  return iface.encodeFunctionData('mintPublic', [
    nftContract,
    feeRecipient,
    minter,
    quantity
  ]);
}

module.exports = {
  SEADROP_ABI,
  SEADROP_ADDRESSES,
  getPublicDropParams,
  encodeMintPublicCalldata
};
