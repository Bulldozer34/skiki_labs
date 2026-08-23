/**
 * Resolver for OpenSea URLs and inputs
 */

/**
 * Resolve OpenSea collection URLs/slugs to contract addresses and slugs.
 * 
 * @param {string} input - Raw contract address, OS collection URL, OS item URL, or slug
 * @returns {object} { address: string|null, slug: string|null, chain: string|null }
 */
function resolveCollection(input) {
  input = input.trim();

  // Case 1: Raw contract address
  const addressRegex = /^(0x[a-fA-F0-9]{40})$/;
  if (addressRegex.test(input)) {
    return { address: input, slug: null, chain: null };
  }

  // Case 2: OpenSea collection URL
  // e.g., https://opensea.io/collection/my-nft or https://opensea.io/collection/0x1234...
  const collectionUrlRegex = /opensea\.io\/collection\/([^/?#]+)/;
  const collectionMatch = input.match(collectionUrlRegex);
  if (collectionMatch) {
    const rawTarget = collectionMatch[1].trim();
    if (addressRegex.test(rawTarget)) {
      return { address: rawTarget, slug: null, chain: null };
    }
    return { address: null, slug: rawTarget, chain: null };
  }

  // Case 3: OpenSea item URL
  // e.g., https://opensea.io/assets/base/0x.../1
  const itemUrlRegex = /opensea\.io\/assets\/([^/]+)\/(0x[a-fA-F0-9]{40})/;
  const itemMatch = input.match(itemUrlRegex);
  if (itemMatch) {
    return { address: itemMatch[2], slug: null, chain: itemMatch[1] };
  }

  // Case 4: Just a slug string
  return { address: null, slug: input, chain: null };
}

module.exports = {
  resolveCollection
};
