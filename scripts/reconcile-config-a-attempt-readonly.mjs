import { writeFileSync } from 'node:fs';
import { createPublicClient, getAddress, http, parseAbiItem } from 'viem';
import { getAmmoraV4NextConfigId, giwaSepoliaAutoRouteDeployment } from '@ammora-protocol/sdk';

const endpoint = 'https://sepolia-rpc.giwa.io';
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const registry = getAddress('0x6d043014972b87406C4757a5f2d655A24e0b0aF9');
const configHash = '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862';
const event = parseAbiItem('event ConfigCreatedV4(uint256 indexed configId, bytes32 indexed configHash, address indexed owner, address feeClaimer, address quoteToken, uint64 createdAtBlock, bytes32 feePolicyVersion)');
const client = createPublicClient({ transport: http(endpoint, { timeout: 20_000, retryCount: 0 }) });
const report = { utc: new Date().toISOString(), endpoint, owner, registry, configHash, result: 'INCOMPLETE', localBrowserMarker: 'INACCESSIBLE_FROM_CODEX', walletActivity: 'OWNER_CHECK_REQUIRED', knownPublicHash: null, checks: {} };
const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
try {
  report.checks.chainId = await client.getChainId();
  if (report.checks.chainId !== 91342 || giwaSepoliaAutoRouteDeployment.contracts.launch.configRegistry.toLowerCase() !== registry.toLowerCase()) throw new Error('Wrong chain or Registry');
  const block = await client.getBlock({ blockTag: 'latest' });
  report.checks.blockNumber = block.number;
  report.checks.blockHash = block.hash;
  report.checks.latestNonce = await client.getTransactionCount({ address: owner, blockTag: 'latest' });
  report.checks.pendingNonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
  report.checks.nativeBalanceWei = await client.getBalance({ address: owner, blockNumber: block.number });
  report.checks.nextConfigId = await getAmmoraV4NextConfigId(client, registry, block.number);
  const matches = [];
  for (let fromBlock = 41_764_000n; fromBlock <= block.number; fromBlock += 9_000n) {
    const toBlock = fromBlock + 8_999n < block.number ? fromBlock + 8_999n : block.number;
    const logs = await client.getLogs({ address: registry, event, args: { configHash, owner }, fromBlock, toBlock });
    for (const log of logs) matches.push({ transactionHash: log.transactionHash, blockNumber: log.blockNumber, configId: log.args.configId, configHash: log.args.configHash, owner: log.args.owner });
  }
  report.checks.matchingConfigCreatedV4 = matches;
  report.checks.scanStartBlock = 41_764_000n;
  report.checks.scanEndBlock = block.number;
  report.result = report.checks.latestNonce === 624 && report.checks.pendingNonce === 624 && report.checks.nextConfigId === 63n && matches.length === 0 ? 'NO_PUBLIC_SEND_EVIDENCE_BUT_LOCAL_OUTCOME_UNKNOWN' : 'BLOCKED_CHAIN_STATE_CHANGED';
} catch (error) {
  report.error = error.shortMessage ?? error.message;
  process.exitCode = 2;
} finally {
  const path = `fixtures/onchain/config-a-attempt-reconciliation-${new Date().toISOString().replaceAll(':', '-')}.json`;
  writeFileSync(path, stringify(report) + '\n');
  console.log(path);
}
