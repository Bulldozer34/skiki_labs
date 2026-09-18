const { Interface, Contract, ZeroAddress, getAddress } = require('ethers');

/**
 * SeaDrop v1 / v2 minimal ABI for public drops
 */
const SEADROP_ABI = [
  'function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) external payable',
  'function getPublicDrop(address nftContract) external view returns (tuple(uint256 mintPrice, uint256 startTime, uint256 endTime, uint256 maxTotalMintableByWallet, uint256 feeBps, bool restrictFeeRecipients))',
  'function getCreatorPayoutAddress(address nftContract) external view returns (address)',
  'function getAllowedFeeRecipients(address nftContract) external view returns (address[])',
  'function getAllowListMerkleRoot(address nftContract) external view returns (bytes32)',
  'function getAllowListDrop(address nftContract) external view returns (tuple(uint256 mintPrice, uint256 maxTotalMintableByWallet, uint256 startTime, uint256 endTime, uint256 dropStageIndex, uint256 maxTokenSupplyForStage, uint256 feeBps, bool restrictFeeRecipients))'
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
  OPTIMISM: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5',
  ARC: '0x00005EA00Ac477B1030CE78506496e8C2dE24bf5'
};

/**
 * Read public drop parameters directly from SeaDrop contract on-chain
 * @param {ethers.Provider} provider 
 * @param {string} seadropAddress 
 * @param {string} nftContractAddress 
 * @returns {Promise<{mintPrice: bigint, startTime: bigint, endTime: bigint, maxMintable: bigint, feeRecipient: string, restrictFeeRecipients: boolean, allowedFeeRecipients: string[]}>}
 */
async function getPublicDropParams(provider, seadropAddress, nftContractAddress) {
  const seadropContract = new Contract(seadropAddress, SEADROP_ABI, provider);
  
  const [publicDrop, creatorPayoutAddress, allowedFeeRecipients] = await Promise.all([
    seadropContract.getPublicDrop(nftContractAddress),
    seadropContract.getCreatorPayoutAddress(nftContractAddress).catch(() => ZeroAddress),
    seadropContract.getAllowedFeeRecipients(nftContractAddress).catch(() => [])
  ]);

  const feeRecipientDetails = resolveMintFeeRecipient({
    creatorPayoutAddress,
    allowedFeeRecipients,
    restrictFeeRecipients: publicDrop.restrictFeeRecipients
  });

  return {
    mintPrice: publicDrop.mintPrice,
    startTime: publicDrop.startTime,
    endTime: publicDrop.endTime,
    maxMintable: publicDrop.maxTotalMintableByWallet,
    feeBps: publicDrop.feeBps,
    restrictFeeRecipients: publicDrop.restrictFeeRecipients,
    allowedFeeRecipients: feeRecipientDetails.allowedFeeRecipients,
    feeRecipient: feeRecipientDetails.feeRecipient,
    feeRecipientSource: feeRecipientDetails.source
  };
}

function normalizeAddressList(addresses) {
  return (addresses || [])
    .filter(address => typeof address === 'string' && address !== ZeroAddress)
    .map(address => {
      try {
        return getAddress(address);
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
}

function resolveMintFeeRecipient({ creatorPayoutAddress, allowedFeeRecipients, restrictFeeRecipients }) {
  const allowed = normalizeAddressList(allowedFeeRecipients);
  const creator = creatorPayoutAddress && creatorPayoutAddress !== ZeroAddress
    ? getAddress(creatorPayoutAddress)
    : ZeroAddress;

  if (restrictFeeRecipients) {
    if (creator !== ZeroAddress && allowed.some(address => address.toLowerCase() === creator.toLowerCase())) {
      return {
        feeRecipient: creator,
        allowedFeeRecipients: allowed,
        source: 'creator_payout_allowed'
      };
    }

    if (allowed.length > 0) {
      return {
        feeRecipient: allowed[0],
        allowedFeeRecipients: allowed,
        source: 'first_allowed_fee_recipient'
      };
    }

    throw new Error('SeaDrop public mint restricts fee recipients, but no allowed fee recipient was found on-chain.');
  }

  const canonicalFeeRecipient = '0x0000a26b00c1F0DF003000390027140000fAa719';
  const resolvedRecipient = creator !== ZeroAddress 
    ? creator 
    : (allowed[0] || canonicalFeeRecipient);

  return {
    feeRecipient: resolvedRecipient,
    allowedFeeRecipients: allowed,
    source: creator !== ZeroAddress 
      ? 'creator_payout' 
      : (allowed[0] ? 'first_allowed_fee_recipient' : 'canonical_fallback')
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

/**
 * Read allowlist drop parameters directly from SeaDrop contract on-chain
 * @param {ethers.Provider} provider 
 * @param {string} seadropAddress 
 * @param {string} nftContractAddress 
 * @returns {Promise<{mintPrice: bigint, maxTotalMintableByWallet: bigint, startTime: bigint, endTime: bigint, dropStageIndex: bigint, maxTokenSupplyForStage: bigint, feeBps: bigint, restrictFeeRecipients: boolean}|null>}
 */
async function getAllowListDropParams(provider, seadropAddress, nftContractAddress) {
  try {
    const seadropContract = new Contract(seadropAddress, SEADROP_ABI, provider);
    const drop = await seadropContract.getAllowListDrop(nftContractAddress);
    return {
      mintPrice: drop.mintPrice,
      maxTotalMintableByWallet: drop.maxTotalMintableByWallet,
      startTime: drop.startTime,
      endTime: drop.endTime,
      dropStageIndex: drop.dropStageIndex,
      maxTokenSupplyForStage: drop.maxTokenSupplyForStage,
      feeBps: drop.feeBps,
      restrictFeeRecipients: drop.restrictFeeRecipients
    };
  } catch (err) {
    return null;
  }
}

module.exports = {
  SEADROP_ABI,
  SEADROP_ADDRESSES,
  getPublicDropParams,
  getAllowListDropParams,
  encodeMintPublicCalldata,
  resolveMintFeeRecipient
};
