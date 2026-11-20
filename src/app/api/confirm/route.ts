import { NextRequest, NextResponse } from 'next/server';
import { isHash, parseEventLogs } from 'viem';
import { factory, publicClient, segmentedALCLaunchFactoryV3Abi } from '@/lib/chain';
import { readJson, updateJson } from '@/lib/storage';
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
  if (process.env.NODE_ENV === 'production' && body.id !== fltestId) return NextResponse.json({ error: 'New token metadata confirmation is unavailable on this deployment' }, { status: 410 });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: body.hash });
    if (receipt.status !== 'success') return NextResponse.json({ error: 'Transaction reverted' }, { status: 422 });
    const canonical = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash !== receipt.blockHash) return NextResponse.json({ error: 'Receipt is no longer canonical' }, { status: 409 });
    const head = await publicClient.getBlockNumber();
    if (head - receipt.blockNumber + 1n < 12n) return NextResponse.json({ error: 'Waiting for 12 canonical confirmations' }, { status: 409 });
    const item = body.id === fltestId ? { creator: fltestOwner as `0x${string}`, uri: fltestUri } : (await readJson<Record<string, SavedMetadata>>('metadata.json', {}))[body.id];
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
    if (body.id !== fltestId) await updateJson<Record<string, SavedMetadata>>('metadata.json', {}, store => {
      const item = store[body.id];
      if (!item || (item.token && item.token.toLowerCase() !== token.toLowerCase())) throw new Error('Metadata binding conflict');
      if (Object.entries(store).some(([id, other]) => id !== body.id && other.token?.toLowerCase() === token.toLowerCase())) throw new Error('Token already bound to metadata');
      item.token = token; item.chainId = 91342;
    });
    return NextResponse.json({ token, hash: body.hash, block: String(receipt.blockNumber) });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'RPC unavailable' }, { status: 503 }); }
}
