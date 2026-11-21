import { NextRequest, NextResponse } from 'next/server';
import { isHash, parseEventLogs } from 'viem';
import { factory, publicClient, segmentedALCLaunchFactoryV3Abi } from '@/lib/chain';
import { redis } from '@/lib/durable';
import { assertLaunchBinding } from '@/lib/launch-binding';
import { assertLaunchPlan } from '@/lib/launch-plan';
import { getAmmoraV4ConfigAtBlock } from '@ammora-protocol/sdk';
import { registry } from '@/lib/chain';
import type { SavedMetadata } from '../metadata/route';
export const runtime = 'nodejs';
const fltestId = 'fltest-v1';
const fltestUri = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
const fltestOwner = '0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5';
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || !isHash(body.hash) || typeof body.id !== 'string' || (body.id !== fltestId && !/^[0-9a-f-]{36}$/.test(body.id))) return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: body.hash });
    if (receipt.status !== 'success') return NextResponse.json({ error: 'Transaction reverted' }, { status: 422 });
    const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) return NextResponse.json({ error: 'Receipt is no longer canonical' }, { status: 409 });
    const head = await publicClient.getBlockNumber();
    if (head - receipt.blockNumber + 1n < 12n) return NextResponse.json({ error: 'Waiting for 12 canonical confirmations' }, { status: 409 });
    const saved = body.id === fltestId ? null : await redis<string>('GET', `fairlaunch:metadata:${body.id}`);
    const item = body.id === fltestId ? { creator: fltestOwner as `0x${string}`, uri: fltestUri } : saved ? JSON.parse(saved) as SavedMetadata : null;
    if (!item) return NextResponse.json({ error: 'Metadata not found' }, { status: 404 });
    const matches = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, eventName: 'LaunchCreated', logs: receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()) });
    const launch = matches.find(log => log.args.metadataURI === item.uri);
    if (!launch || !launch.args.token) return NextResponse.json({ error: 'No matching confirmed Ammora launch' }, { status: 422 });
    const token = launch.args.token;
    const transaction = await publicClient.getTransaction({ hash: body.hash });
    const chainId = await publicClient.getChainId();
    if (body.id === fltestId) {
      if (launch.args.configId !== 63n) return NextResponse.json({ error: 'FLTEST Config ID mismatch' }, { status: 422 });
      try { assertLaunchPlan({ to: transaction.to!, data: transaction.input, value: transaction.value }, { factory, name: 'FairLaunch Test', symbol: 'FLTEST', uri: fltestUri, configId: 63n, decimals: 9, fee: 0n }); }
      catch { return NextResponse.json({ error: 'FLTEST launch calldata mismatch' }, { status: 422 }); }
      const [tokenCode, curveCode, config] = await Promise.all([
        publicClient.getCode({ address: token, blockNumber: receipt.blockNumber }),
        publicClient.getCode({ address: launch.args.curve, blockNumber: receipt.blockNumber }),
        getAmmoraV4ConfigAtBlock(publicClient, registry, 63n, receipt.blockNumber),
      ]);
      if (!tokenCode || tokenCode === '0x' || !curveCode || curveCode === '0x' || config.configHash.toLowerCase() !== '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862') return NextResponse.json({ error: 'FLTEST token, curve or Config readback mismatch' }, { status: 422 });
    }
    try { assertLaunchBinding({ chainId, expectedCreator: item.creator, expectedURI: item.uri, factory, transactionFrom: transaction.from, transactionTo: transaction.to, receiptTo: receipt.to, eventCreator: launch.args.creator, eventURI: launch.args.metadataURI, token }); }
    catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Launch binding invalid' }, { status: 422 }); }
    if (body.id !== fltestId) {
      if (!launch.args.configId || !launch.args.curve) return NextResponse.json({ error: 'Incomplete Factory event' }, { status: 422 });
      const [config, tokenCode, curveCode] = await Promise.all([
        getAmmoraV4ConfigAtBlock(publicClient, registry, launch.args.configId, receipt.blockNumber),
        publicClient.getCode({ address: token, blockNumber: receipt.blockNumber }),
        publicClient.getCode({ address: launch.args.curve, blockNumber: receipt.blockNumber }),
      ]);
      if (!config.enabled || !tokenCode || tokenCode === '0x' || !curveCode || curveCode === '0x') return NextResponse.json({ error: 'Config or deployed code readback failed' }, { status: 422 });
      const metadata = item as SavedMetadata;
      try { assertLaunchPlan({ to: transaction.to!, data: transaction.input, value: transaction.value }, { factory, name: metadata.input.name, symbol: metadata.input.symbol, uri: metadata.uri, configId: launch.args.configId, decimals: config.config.tokenDecimals, fee: config.config.poolCreationFee }); }
      catch { return NextResponse.json({ error: 'Launch calldata does not match metadata and Config' }, { status: 422 }); }
    }
    if (body.id !== fltestId) {
      const prior = await redis<string>('GET', `fairlaunch:token:${token.toLowerCase()}`);
      if (prior && prior !== body.id) return NextResponse.json({ error: 'Token already bound to other metadata' }, { status: 409 });
      const recorded = await redis<string>('SET', `fairlaunch:token:${token.toLowerCase()}`, body.id, 'NX');
      if (recorded !== 'OK' && !prior) return NextResponse.json({ error: 'Token binding race; retry readback' }, { status: 409 });
      if (!launch.args.curve || !launch.args.creator || launch.args.configId === undefined) return NextResponse.json({ error: 'Incomplete Factory event' }, { status: 422 });
      await redis('HSET', 'fairlaunch:confirmed-launches', token.toLowerCase(), JSON.stringify({ token, curve: launch.args.curve, creator: launch.args.creator, configId: String(launch.args.configId), metadataURI: item.uri, hash: body.hash, block: String(receipt.blockNumber), blockHash: receipt.blockHash }));
    }
    return NextResponse.json({ token, hash: body.hash, block: String(receipt.blockNumber) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'RPC unavailable' }, { status: 503 }); }
}
