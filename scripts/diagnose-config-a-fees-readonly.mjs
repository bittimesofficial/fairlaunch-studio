import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionData, defineChain, encodeFunctionData, http, keccak256, parseAbi, serializeTransaction } from 'viem';
import { estimateL1Fee } from 'viem/op-stack';
import { ammoraLaunchConfigRegistryV4Abi } from '@ammora-protocol/sdk';

const old = JSON.parse(readFileSync(new URL('../fixtures/onchain/owner-preflight-2026-11-19T18-10-54.878Z.json', import.meta.url)));
const changed = JSON.parse(readFileSync(new URL('../fixtures/onchain/owner-preflight-2026-11-19T23-05-03.659Z.json', import.meta.url)));
const endpoint = 'https://sepolia-rpc.giwa.io';
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [endpoint] } } });
const client = createPublicClient({ chain, transport: http(endpoint, { timeout: 20_000, retryCount: 0 }) });
const oracle = '0x420000000000000000000000000000000000000F';
const abi = parseAbi([
  'function getL1Fee(bytes) view returns (uint256)',
  'function getL1FeeUpperBound(uint256) view returns (uint256)',
  'function getL1GasUsed(bytes) view returns (uint256)',
  'function getOperatorFee(uint256) view returns (uint256)',
  'function l1BaseFee() view returns (uint256)',
  'function baseFeeScalar() view returns (uint32)',
  'function blobBaseFee() view returns (uint256)',
  'function blobBaseFeeScalar() view returns (uint32)',
  'function version() view returns (string)',
  'function isFjord() view returns (bool)',
]);
const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const report = { utc: new Date().toISOString(), endpoint, oracle, units: 'wei unless named bytes or gas', snapshots: [] };
const read = (functionName, args, blockNumber) => client.readContract({ address: oracle, abi, functionName, args, blockNumber });
const attempt = async (functionName, args, blockNumber) => {
  try { return await read(functionName, args, blockNumber); }
  catch (error) { return { error: error.shortMessage ?? error.message }; }
};

try {
  if (await client.getChainId() !== 91342) throw new Error('Wrong chain');
  const latest = await client.getBlock({ blockTag: 'latest' });
  for (const source of [old, changed, { ...changed, chain: { ...changed.chain, blockNumber: latest.number.toString(), blockHash: latest.hash }, feeEstimate: await client.estimateFeesPerGas(), ownerState: { ...changed.ownerState, nonceLatest: await client.getTransactionCount({ address: changed.input.owner, blockTag: 'latest' }) }, planA: { ...changed.planA, l1FeeEstimateWei: null } }]) {
    const blockNumber = BigInt(source.chain.blockNumber);
    const block = await client.getBlock({ blockNumber });
    if (block.hash !== source.chain.blockHash) throw new Error(`Block hash mismatch at ${blockNumber}`);
    const data = source.planA.data;
    const decoded = decodeFunctionData({ abi: ammoraLaunchConfigRegistryV4Abi, data });
    if (decoded.functionName !== 'createConfig' || keccak256(data) !== '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309') throw new Error('Calldata mismatch');
    const maxFeePerGas = BigInt(source.feeEstimate.maxFeePerGas);
    const maxPriorityFeePerGas = BigInt(source.feeEstimate.maxPriorityFeePerGas);
    const gas = BigInt(source.planA.gasLimitReview);
    const unsigned = serializeTransaction({ type: 'eip1559', chainId: 91342, nonce: source.ownerState.nonceLatest, gas, maxFeePerGas, maxPriorityFeePerGas, to: source.planA.to, value: 0n, data });
    const unsignedBytes = (unsigned.length - 2) / 2;
    const callData = encodeFunctionData({ abi, functionName: 'getL1Fee', args: [unsigned] });
    const raw = await client.request({ method: 'eth_call', params: [{ to: oracle, data: callData }, `0x${blockNumber.toString(16)}`] });
    const item = {
      blockNumber, blockHash: block.hash, blockTimestamp: block.timestamp,
      sourceReportedL1FeeWei: source.planA.l1FeeEstimateWei,
      calldataHash: keccak256(data), calldataBytes: (data.length - 2) / 2,
      unsignedTransactionBytes: unsignedBytes, unsignedTransactionHash: keccak256(unsigned),
      unsignedParameters: { from: source.input.owner, to: source.planA.to, chainId: 91342, nonce: source.ownerState.nonceLatest, gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n },
      rawEthCallGetL1FeeWei: BigInt(raw),
      getL1FeeWei: await attempt('getL1Fee', [unsigned], blockNumber),
      getL1FeeUpperBoundWei: await attempt('getL1FeeUpperBound', [BigInt(unsignedBytes)], blockNumber),
      getL1GasUsed: await attempt('getL1GasUsed', [unsigned], blockNumber),
      getOperatorFeeWei: await attempt('getOperatorFee', [gas], blockNumber),
      l1BaseFeeWeiPerGas: await attempt('l1BaseFee', [], blockNumber),
      baseFeeScalar: await attempt('baseFeeScalar', [], blockNumber),
      blobBaseFeeWeiPerGas: await attempt('blobBaseFee', [], blockNumber),
      blobBaseFeeScalar: await attempt('blobBaseFeeScalar', [], blockNumber),
      oracleVersion: await attempt('version', [], blockNumber),
      isFjord: await attempt('isFjord', [], blockNumber),
    };
    if (blockNumber === latest.number) {
      item.viemEstimateL1FeeWei = await estimateL1Fee(client, { account: source.input.owner, to: source.planA.to, data, value: 0n, gasPriceOracleAddress: oracle });
      item.executionGasEstimate = await client.estimateGas({ account: source.input.owner, to: source.planA.to, data, value: 0n, blockNumber });
      item.ownerBalanceWei = await client.getBalance({ address: source.input.owner, blockNumber });
      item.noncePending = await client.getTransactionCount({ address: source.input.owner, blockTag: 'pending' });
    }
    report.snapshots.push(item);
  }
  report.status = 'PASS';
} catch (error) {
  report.status = 'INCOMPLETE';
  report.error = error.shortMessage ?? error.message;
  process.exitCode = 2;
} finally {
  const path = `fixtures/onchain/config-a-fee-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.json`;
  writeFileSync(path, stringify(report) + '\n');
  console.log(path);
}
