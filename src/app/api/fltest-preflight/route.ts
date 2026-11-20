import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { buildCreateAmmoraV4Launch, giwaSepoliaAtomicLaunchDeployment, verifyAmmoraPortableDeploymentAtBlock } from '@ammora-protocol/sdk';
import { getAddress, keccak256, parseAbi, parseEventLogs, serializeTransaction } from 'viem';
import { factory, publicClient, segmentedALCLaunchFactoryV3Abi } from '@/lib/chain';
import { attestConfigA } from '@/lib/config-a-attestation';

export const dynamic = 'force-dynamic';
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const uri = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
const metadataSha256 = 'c8421af3a27fb87c1d29196a1039783062b1cd2c9da0f467b55be6c8c3a56d2e';
const configHash = '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862';
const oracle = '0x420000000000000000000000000000000000000F';
const oracleAbi = parseAbi(['function getL1FeeUpperBound(uint256) view returns (uint256)']);
const fail = (message: string) => { throw new Error(message); };

export async function GET() {
  try {
    const block = await publicClient.getBlock({ blockTag: 'latest' });
    if (await publicClient.getChainId() !== 91342) fail('Wrong GIWA chain');
    await verifyAmmoraPortableDeploymentAtBlock(publicClient, giwaSepoliaAtomicLaunchDeployment, block.number);
    const config = await attestConfigA(publicClient, block.number);
    const metadata = await fetch(uri, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!metadata.ok || !/^application\/json\b/i.test(metadata.headers.get('content-type') ?? '')) fail('FLTEST metadata unavailable');
    const bytes = Buffer.from(await metadata.arrayBuffer());
    if (bytes.length > 3000 || createHash('sha256').update(bytes).digest('hex') !== metadataSha256) fail('FLTEST metadata digest changed');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed.name !== 'FairLaunch Test' || parsed.symbol !== 'FLTEST' || parsed.chainId !== 91342) fail('FLTEST metadata identity changed');
    const launchEvent = segmentedALCLaunchFactoryV3Abi.find(item => item.type === 'event' && item.name === 'LaunchCreated') as Extract<typeof segmentedALCLaunchFactoryV3Abi[number], { type: 'event' }>;
    for (let from = 41804688n; from <= block.number; from += 9000n) {
      const to = from + 8999n < block.number ? from + 8999n : block.number;
      const logs = await publicClient.getLogs({ address: factory, event: launchEvent, fromBlock: from, toBlock: to });
      for (const log of logs) {
        const event = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, logs: [log], eventName: 'LaunchCreated' })[0];
        if (event?.args.configId === 63n && event.args.creator?.toLowerCase() === owner.toLowerCase() && event.args.metadataURI === uri) fail(`FLTEST already launched: ${log.transactionHash}`);
      }
    }
    const [latestNonce, pendingNonce, balance] = await Promise.all([
      publicClient.getTransactionCount({ address: owner, blockTag: 'latest' }),
      publicClient.getTransactionCount({ address: owner, blockTag: 'pending' }),
      publicClient.getBalance({ address: owner, blockNumber: block.number }),
    ]);
    if (pendingNonce !== latestNonce) fail('Owner has a pending transaction');
    const plan = buildCreateAmmoraV4Launch({ name: 'FairLaunch Test', symbol: 'FLTEST', metadataURI: uri, creatorMetadataURI: uri, tokenDecimals: config.config.tokenDecimals }, 63n, config.config.poolCreationFee);
    await publicClient.call({ account: owner, to: factory, data: plan.data, value: plan.value, blockNumber: block.number });
    const gasEstimate = await publicClient.estimateGas({ account: owner, to: factory, data: plan.data, value: plan.value, blockNumber: block.number });
    const gasLimit = (gasEstimate * 120n + 99n) / 100n;
    const fees = await publicClient.estimateFeesPerGas();
    if (!fees.maxFeePerGas || !fees.maxPriorityFeePerGas || fees.maxPriorityFeePerGas > fees.maxFeePerGas) fail('Fee estimate unavailable');
    const unsigned = serializeTransaction({ type: 'eip1559', chainId: 91342, nonce: latestNonce, gas: gasLimit, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas, to: factory, value: plan.value, data: plan.data });
    const l1UpperBound = await publicClient.readContract({ address: oracle, abi: oracleAbi, functionName: 'getL1FeeUpperBound', args: [BigInt((unsigned.length - 2) / 2)], blockNumber: block.number });
    const reserve = gasLimit * fees.maxFeePerGas + l1UpperBound + plan.value;
    if (balance < reserve) fail('Owner ETH balance below launch fee reserve');
    return NextResponse.json({ status: 'REVIEW_ONLY', chainId: 91342, asOfBlock: block.number.toString(), from: owner, to: factory, configId: '63', configHash, name: 'FairLaunch Test', symbol: 'FLTEST', metadataURI: uri, metadataSha256, firstBuy: false, data: plan.data, calldataHash: keccak256(plan.data), valueWei: plan.value.toString(), nonce: latestNonce, gasEstimate: gasEstimate.toString(), gasLimit: gasLimit.toString(), maxFeePerGas: fees.maxFeePerGas.toString(), maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(), l1UpperBoundWei: l1UpperBound.toString(), reserveWei: reserve.toString(), balanceWei: balance.toString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ status: 'BLOCKED', error: error instanceof Error ? error.message : 'FLTEST preflight failed' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
