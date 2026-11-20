import { NextResponse } from 'next/server';
import { giwaSepoliaAtomicLaunchDeployment, verifyAmmoraPortableDeploymentAtBlock } from '@ammora-protocol/sdk';
import { publicClient } from '@/lib/chain';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const block = await publicClient.getBlockNumber();
    const result = await verifyAmmoraPortableDeploymentAtBlock(publicClient, giwaSepoliaAtomicLaunchDeployment, block);
    return NextResponse.json({ chainId: result.chainId, block: String(result.blockNumber), checkedContracts: Object.keys(giwaSepoliaAtomicLaunchDeployment.security.runtimeCodeHashes).length }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'Runtime attestation failed' }, { status: 503 }); }
}
