import { writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256 } from 'viem';
import { giwaSepoliaAutoRouteDeployment } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const forkBlock = 41715770;
const forkHash = '0xeea8192215013ad2dfd0f9564f43dbf448c0eab5f9150151a83da21fee042a9a';
const launch = giwaSepoliaAutoRouteDeployment.contracts.launch;
const pins = {
  [launch.factory.toLowerCase()]: '0xf4bdf481252fb37bae95df148ba66e788ff59f22205d4e9c2f4df2c55c4fa173',
  [launch.configRegistry.toLowerCase()]: '0xd74516d51f2d02dba03d09828ecfa1bcbca363b295765cf57f8c07401826b257',
  [launch.firstBuyExecutor.toLowerCase()]: '0x0c2dea9d7e87f7974191b02162a131dbe38fd500681e835a2cb20b7a8b9f62e4',
};
const rpc = async (method, params = []) => {
  const response = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
};
const evidence = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', status: 'BLOCKED', pins: {} };
try {
  const [metadata, chainId, blockNumber] = await Promise.all([rpc('hardhat_metadata'), rpc('eth_chainId'), rpc('eth_blockNumber')]);
  evidence.identity = { metadata, chainId, blockNumber };
  if (chainId !== '0x164ce' || metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== forkBlock || metadata.forkedNetwork?.forkBlockHash !== forkHash || BigInt(blockNumber) < BigInt(forkBlock)) throw new Error('Wrong fork identity');
  if (process.argv.includes('--fresh') && BigInt(blockNumber) !== BigInt(forkBlock)) throw new Error('Fork is not at pristine block');
  const client = createPublicClient({ transport: http(local, { timeout: 20_000, retryCount: 0 }) });
  for (const [address, expected] of Object.entries(pins)) {
    const code = await client.getCode({ address, blockNumber: BigInt(forkBlock) });
    const actual = keccak256(code);
    evidence.pins[address] = { expected, actual, match: actual === expected };
    if (actual !== expected) throw new Error(`Runtime mismatch ${address}`);
  }
  evidence.status = 'PASS';
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
}
const path = `fixtures/onchain/local-fork-preflight-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
console.log(path);
