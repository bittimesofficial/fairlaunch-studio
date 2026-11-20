import { NextResponse } from 'next/server';
import { publicClient } from '@/lib/chain';
import { readV4Configs } from '@/lib/config';
import { attestConfigA } from '@/lib/config-a-attestation';
import type { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export async function GET(request: NextRequest) {
  try {
    const blockNumber = await publicClient.getBlockNumber();
    const page = request.nextUrl.searchParams.get('focus') === 'config-a'
      ? { asOfBlock: blockNumber, items: [{ ...await attestConfigA(publicClient, blockNumber), launchEligible: true, reason: 'Canonical Config A receipt and full on-chain policy/curve readback verified' }] }
      : await readV4Configs(publicClient, blockNumber);
    return new NextResponse(JSON.stringify(page, (_key, value) => typeof value === 'bigint' ? value.toString() : value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'RPC unavailable' }, { status: 503 }); }
}
