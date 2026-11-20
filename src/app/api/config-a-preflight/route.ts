import { readFileSync } from 'node:fs';
import { NextResponse } from 'next/server';
import { createPublicClient, decodeFunctionData, decodeFunctionResult, defineChain, getAddress, http, keccak256, parseAbi, parseAbiItem, serializeTransaction } from 'viem';
import { ammoraLaunchConfigRegistryV4Abi, getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId, giwaSepoliaAtomicLaunchDeployment, giwaSepoliaAutoRouteDeployment, verifyAmmoraPortableDeploymentAtBlock } from '@ammora-protocol/sdk';
import { verifyConfigANonceHistory } from '@/lib/config-a-nonce-history';

export const dynamic = 'force-dynamic';
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const registry = getAddress('0x6d043014972b87406C4757a5f2d655A24e0b0aF9');
const oracle = getAddress('0x420000000000000000000000000000000000000F');
const calldataHash = '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309';
const configHash = '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862';
const templateHash = '0xec0f91c5bf2943454abdc139170e5ea204a38fc1e102541a6a27224ec881a293';
const spendingCeilingWei = 300_000_000_000_000n; // 0.0003 ETH; operator policy, not a protocol cap.
const abi = parseAbi(['function getL1Fee(bytes) view returns (uint256)', 'function getL1FeeUpperBound(uint256) view returns (uint256)', 'function getOperatorFee(uint256) view returns (uint256)']);
const createdEvent = parseAbiItem('event ConfigCreatedV4(uint256 indexed configId, bytes32 indexed configHash, address indexed owner, address feeClaimer, address quoteToken, uint64 createdAtBlock, bytes32 feePolicyVersion)');
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } } });
const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { timeout: 20_000, retryCount: 0 }) });
const stringify = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

export async function GET() {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'Config A was already created; this preparation route is retired' }, { status: 410 });
  try {
    const approved = JSON.parse(readFileSync(`${process.cwd()}/fixtures/onchain/owner-preflight-2026-11-19T18-10-54.878Z.json`, 'utf8'));
    const data = approved.planA.data as `0x${string}`;
    if (keccak256(data) !== calldataHash || approved.planA.simulatedReturn[1] !== configHash) throw new Error('Approved Config A fixture changed');
    const decoded = decodeFunctionData({ abi: ammoraLaunchConfigRegistryV4Abi, data });
    if (decoded.functionName !== 'createConfig' || !decoded.args || stringify(decoded.args[0]) !== stringify(approved.policy.config) || stringify(decoded.args[1]) !== stringify(approved.policy.curve) || getAddress(decoded.args[2]) !== owner) throw new Error('Config A decode mismatch');
    const config = decoded.args[0];
    if (getAddress(config.partnerRecipient) !== owner || getAddress(config.liquidityDistribution.partner) !== owner || getAddress(config.leftoverReceiver) !== owner) throw new Error('Recipient mismatch');
    const block = await client.getBlock({ blockTag: 'latest' });
    if (await client.getChainId() !== 91342) throw new Error('Wrong GIWA chain');
    const deployment = giwaSepoliaAtomicLaunchDeployment;
    const pins: Record<string, `0x${string}`> = deployment.security.runtimeCodeHashes;
    const targets = giwaSepoliaAutoRouteDeployment.contracts.launch;
    for (const address of [targets.factory, registry, targets.firstBuyExecutor] as `0x${string}`[]) {
      const code = await client.getCode({ address, blockNumber: block.number });
      if (!code || keccak256(code) !== pins[address.toLowerCase()]) throw new Error(`Runtime mismatch at ${address}`);
    }
    await verifyAmmoraPortableDeploymentAtBlock(client, deployment, block.number);
    const template = await getAmmoraV4ConfigAtBlock(client, registry, 10n, block.number);
    const nextId = await getAmmoraV4NextConfigId(client, registry, block.number);
    if (!template.enabled || template.configHash !== templateHash || nextId !== 63n) throw new Error('Registry template or next ID changed; reconcile previous sends');
    const latestNonce = await client.getTransactionCount({ address: owner, blockTag: 'latest' });
    const pendingNonce = await client.getTransactionCount({ address: owner, blockTag: 'pending' });
    if (pendingNonce !== latestNonce) throw new Error('Owner pending transaction exists');
    await verifyConfigANonceHistory(latestNonce, block.number);
    for (let fromBlock = 41_764_000n; fromBlock <= block.number; fromBlock += 9_000n) {
      const toBlock = fromBlock + 8_999n < block.number ? fromBlock + 8_999n : block.number;
      const matches = await client.getLogs({ address: registry, event: createdEvent, args: { configHash, owner }, fromBlock, toBlock });
      if (matches.length) throw new Error('Identical Config A already created; inspect receipt');
    }
    const balance = await client.getBalance({ address: owner, blockNumber: block.number });
    const result = await client.call({ account: owner, to: registry, data, value: 0n, blockNumber: block.number });
    const simulated = decodeFunctionResult({ abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'createConfig', data: result.data! });
    if (simulated[0] !== 63n || simulated[1] !== configHash) throw new Error('Config A simulation differs');
    const gasEstimate = await client.estimateGas({ account: owner, to: registry, data, value: 0n, blockNumber: block.number });
    const gasLimit = (gasEstimate * 120n + 99n) / 100n;
    const fees = await client.estimateFeesPerGas();
    if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas || fees.maxFeePerGas < fees.maxPriorityFeePerGas) throw new Error('Invalid EIP-1559 fee estimate');
    const unsigned = serializeTransaction({ type: 'eip1559', chainId: 91342, nonce: latestNonce, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: registry, value: 0n, data });
    const unsignedBytes = BigInt((unsigned.length - 2) / 2);
    const [l1Fee, l1UpperBound, operatorFee] = await Promise.all([
      client.readContract({ address: oracle, abi, functionName: 'getL1Fee', args: [unsigned], blockNumber: block.number }),
      client.readContract({ address: oracle, abi, functionName: 'getL1FeeUpperBound', args: [unsignedBytes], blockNumber: block.number }),
      client.readContract({ address: oracle, abi, functionName: 'getOperatorFee', args: [gasLimit], blockNumber: block.number }),
    ]);
    const executionCap = gasLimit * fees.maxFeePerGas;
    const reserve = executionCap + l1UpperBound + operatorFee;
    if (l1UpperBound < l1Fee || reserve > spendingCeilingWei || reserve > balance) throw new Error('Fee reserve exceeds policy ceiling or balance');
    return NextResponse.json({ status: 'REVIEW_ONLY', asOfBlock: block.number.toString(), asOfBlockHash: block.hash, chainId: 91342, from: owner, to: registry, valueWei: '0', selector: data.slice(0, 10), calldataHash, configHash, data, nonce: latestNonce, gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), unsignedBytes: unsignedBytes.toString(), l1FeeWei: l1Fee.toString(), l1UpperBoundWei: l1UpperBound.toString(), operatorFeeWei: operatorFee.toString(), executionCapWei: executionCap.toString(), reserveWei: reserve.toString(), spendingCeilingWei: spendingCeilingWei.toString(), balanceWei: balance.toString(), recipients: { configOwner: owner, partnerFeeRecipient: owner, partnerLpOwner: owner, leftoverReceiver: owner }, warning: 'L1 fee and oracle upper bound can change before inclusion. Inspect the wallet fee preview and cancel if its total exceeds 0.0003 ETH.' }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ status: 'BLOCKED', error: error instanceof Error ? error.message : 'Preflight failed' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
