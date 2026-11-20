import { createPublicClient, getAddress, http, keccak256 } from 'viem';

const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const registry = getAddress('0x6d043014972b87406C4757a5f2d655A24e0b0aF9');
const calldataHash = '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309';
const client = createPublicClient({ transport: http('https://sepolia-rpc.giwa.io', { timeout: 20_000, retryCount: 0 }) });

export async function verifyConfigANonceHistory(latestNonce: number, asOfBlock: bigint) {
  if (!Number.isSafeInteger(latestNonce) || latestNonce < 624 || latestNonce - 624 > 64) throw new Error('Owner nonce outside bounded Config A recovery window');
  if (latestNonce === 624) return [];
  const url = new URL('https://sepolia-explorer.giwa.io/api');
  url.search = new URLSearchParams({ module: 'account', action: 'txlist', address: owner, startblock: '41764000', endblock: asOfBlock.toString(), sort: 'asc', page: '1', offset: '1000' }).toString();
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error('Owner transaction index unavailable');
  const listing = await response.json() as { message?: string; result?: unknown };
  if (listing.message !== 'OK' || !Array.isArray(listing.result) || listing.result.length >= 1000) throw new Error('Owner transaction index incomplete');
  const byNonce = new Map<number, { hash: `0x${string}` }>();
  for (const item of listing.result as { from?: string; nonce?: string; hash?: string }[]) {
    if (item.from?.toLowerCase() !== owner.toLowerCase()) continue;
    const nonce = Number(item.nonce);
    if (nonce < 624 || nonce >= latestNonce) continue;
    if (!Number.isSafeInteger(nonce) || !item.hash || !/^0x[0-9a-fA-F]{64}$/.test(item.hash) || byNonce.has(nonce)) throw new Error('Owner transaction index has ambiguous nonce');
    byNonce.set(nonce, { hash: item.hash as `0x${string}` });
  }
  const verified = [];
  for (let nonce = 624; nonce < latestNonce; nonce++) {
    const indexed = byNonce.get(nonce);
    if (!indexed) throw new Error(`Confirmed owner transaction at nonce ${nonce} not found`);
    const [tx, receipt] = await Promise.all([client.getTransaction({ hash: indexed.hash }), client.getTransactionReceipt({ hash: indexed.hash })]);
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (getAddress(tx.from) !== owner || tx.nonce !== nonce || tx.hash !== receipt.transactionHash || receipt.blockHash !== canonical.hash || receipt.blockNumber > asOfBlock || asOfBlock - receipt.blockNumber + 1n < 12n) throw new Error(`Owner transaction at nonce ${nonce} is not final and canonical`);
    if (tx.to?.toLowerCase() === registry.toLowerCase() || keccak256(tx.input) === calldataHash) throw new Error(`Registry or Config A transaction found at nonce ${nonce}: ${tx.hash}`);
    verified.push({ nonce, hash: tx.hash, to: tx.to, status: receipt.status, blockNumber: receipt.blockNumber.toString() });
  }
  return verified;
}
