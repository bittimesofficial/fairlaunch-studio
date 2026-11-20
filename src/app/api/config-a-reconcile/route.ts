import { readFileSync } from 'node:fs';
import { NextRequest, NextResponse } from 'next/server';
import { createPublicClient, getAddress, http, keccak256, parseAbiItem, TransactionReceiptNotFoundError } from 'viem';
import { getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId, parseAmmoraV4ConfigCreatedReceipt } from '@ammora-protocol/sdk';
import { verifyConfigANonceHistory } from '@/lib/config-a-nonce-history';

export const dynamic = 'force-dynamic';
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const registry = getAddress('0x6d043014972b87406C4757a5f2d655A24e0b0aF9');
const configHash = '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862';
const calldataHash = '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309';
const created = parseAbiItem('event ConfigCreatedV4(uint256 indexed configId, bytes32 indexed configHash, address indexed owner, address feeClaimer, address quoteToken, uint64 createdAtBlock, bytes32 feePolicyVersion)');
const client = createPublicClient({ transport: http('https://sepolia-rpc.giwa.io', { timeout: 20_000, retryCount: 0 }) });
const stringify = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export async function GET(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') return json({ status: 'RETIRED', reason: 'Config A was already created' }, 410);
  try {
    const hash = request.nextUrl.searchParams.get('hash');
    if (hash && !/^0x[0-9a-fA-F]{64}$/.test(hash)) return json({ status: 'BLOCKED', reason: 'Invalid transaction hash' }, 400);
    const chainId = await client.getChainId();
    if (chainId !== 91342) throw new Error('Wrong chain');
    const block = await client.getBlock({ blockTag: 'latest' });
    const [latestNonce, pendingNonce, nextConfigId] = await Promise.all([
      client.getTransactionCount({ address: owner, blockTag: 'latest' }),
      client.getTransactionCount({ address: owner, blockTag: 'pending' }),
      getAmmoraV4NextConfigId(client, registry, block.number),
    ]);
    const matches = [];
    for (let fromBlock = 41_764_000n; fromBlock <= block.number; fromBlock += 9_000n) {
      const toBlock = fromBlock + 8_999n < block.number ? fromBlock + 8_999n : block.number;
      matches.push(...await client.getLogs({ address: registry, event: created, args: { configHash, owner }, fromBlock, toBlock }));
    }
    const base = { chainId, owner, registry, blockNumber: block.number.toString(), blockHash: block.hash, latestNonce, pendingNonce, nextConfigId: nextConfigId.toString(), matchingEvents: matches.map(item => ({ hash: item.transactionHash, configId: item.args.configId?.toString() })) };
    const inspectReceipt = async (txHash: `0x${string}`) => {
      let receipt;
      try { receipt = await client.getTransactionReceipt({ hash: txHash }); }
      catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
        return json({ ...base, status: 'PENDING_OR_UNKNOWN_HASH', transactionHash: txHash, reason: 'No public receipt for saved hash; do not retry' });
      }
      const tx = await client.getTransaction({ hash: txHash });
      const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      if (receipt.blockHash !== canonical.hash) return json({ ...base, status: 'BLOCKED_NONCANONICAL_RECEIPT', transactionHash: txHash });
      if (getAddress(tx.from) !== owner || !tx.to || getAddress(tx.to) !== registry || tx.value !== 0n || keccak256(tx.input) !== calldataHash || receipt.to?.toLowerCase() !== registry.toLowerCase()) return json({ ...base, status: 'BLOCKED_TX_MISMATCH', transactionHash: txHash });
      if (receipt.status !== 'success') return json({ ...base, status: 'FAILED_RECEIPT', transactionHash: txHash, receiptBlock: receipt.blockNumber.toString() });
      if (block.number - receipt.blockNumber + 1n < 12n) return json({ ...base, status: 'PENDING_CONFIRMATIONS', transactionHash: txHash, receiptBlock: receipt.blockNumber.toString(), confirmations: (block.number - receipt.blockNumber + 1n).toString() });
      const event = parseAmmoraV4ConfigCreatedReceipt(receipt, registry);
      const actual = await getAmmoraV4ConfigAtBlock(client, registry, event.configId, block.number);
      const approved = JSON.parse(readFileSync(`${process.cwd()}/fixtures/onchain/owner-preflight-2026-11-19T18-10-54.878Z.json`, 'utf8'));
      const match = event.owner.toLowerCase() === owner.toLowerCase() && event.feeClaimer.toLowerCase() === owner.toLowerCase() && event.configHash.toLowerCase() === configHash && actual.identity.owner.toLowerCase() === owner.toLowerCase() && actual.enabled && actual.configHash.toLowerCase() === configHash && stringify(actual.config) === stringify(approved.policy.config) && stringify(actual.segments) === stringify(approved.policy.curve);
      return json({ ...base, status: match ? 'CONFIRMED_CONFIG_A' : 'BLOCKED_READBACK_MISMATCH', transactionHash: txHash, receiptBlock: receipt.blockNumber.toString(), configId: event.configId.toString(), configHash: event.configHash, confirmations: (block.number - receipt.blockNumber + 1n).toString() });
    };
    if (hash) return inspectReceipt(hash as `0x${string}`);
    if (matches.length) return inspectReceipt(matches[0].transactionHash);
    if (nextConfigId !== 63n) return json({ ...base, status: 'BLOCKED_CHAIN_STATE_CHANGED', reason: `Registry next ID changed from 63 to ${nextConfigId}` });
    if (pendingNonce !== latestNonce) return json({ ...base, status: 'BLOCKED_PENDING_TRANSACTION', reason: `Owner pending nonce ${pendingNonce} differs from confirmed nonce ${latestNonce}` });
    let nonceTransactions;
    try { nonceTransactions = await verifyConfigANonceHistory(latestNonce, block.number); }
    catch (error) { return json({ ...base, status: 'BLOCKED_TX_HISTORY_UNVERIFIED', reason: error instanceof Error ? error.message : 'Owner transaction history unavailable' }); }
    return json({ ...base, nonceTransactions, status: 'NO_CONFIG_A_SEND_EVIDENCE', reason: 'Confirmed owner nonce changes belong to other transactions; no matching Registry event or visible pending transaction. Owner no-Confirm attestation is still required.' });
  } catch (error) {
    return json({ status: 'BLOCKED_RPC', reason: error instanceof Error ? error.message : 'Public reconciliation failed' }, 503);
  }
}
