import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getAddress, isAddress } from 'viem';
import { durableReady, limit, redis } from '../../../../lib/durable';
import { boundedJson } from '../../../../lib/request-body';
export const runtime = 'nodejs';
export async function POST(request: NextRequest) {
  if (!durableReady() || !process.env.NEXT_PUBLIC_APP_ORIGIN?.startsWith('https://')) return NextResponse.json({ error: 'Metadata service unavailable' }, { status: 503 });
  if (request.headers.get('origin') !== process.env.NEXT_PUBLIC_APP_ORIGIN) return NextResponse.json({ error: 'Origin mismatch' }, { status: 403 });
  const body = await boundedJson(request, 1024).catch(() => null) as { creator?: string; digest?: string } | null;
  if (!body || typeof body.creator !== 'string' || !isAddress(body.creator) || typeof body.digest !== 'string' || !/^[0-9a-f]{64}$/.test(body.digest)) return NextResponse.json({ error: 'Invalid challenge request' }, { status: 400 });
  const creator = getAddress(body.creator);
  try {
    const ip = request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    if (!(await limit(`challenge-ip:${ip}`, 30, 3600)) || !(await limit(`challenge-wallet:${creator}`, 8, 3600)) || !(await limit('challenge-global', 300, 3600))) return NextResponse.json({ error: 'Challenge limit exceeded' }, { status: 429 });
    const nonce = randomUUID(); const expires = new Date(Date.now() + 5 * 60_000).toISOString();
    const message = `FairLaunch Studio metadata upload\nDomain: ${new URL(process.env.NEXT_PUBLIC_APP_ORIGIN).host}\nChain ID: 91342\nCreator: ${creator}\nSHA-256: ${body.digest}\nNonce: ${nonce}\nExpires: ${expires}`;
    await redis('SET', `fairlaunch:nonce:${nonce}`, JSON.stringify([creator, body.digest, message]), 'EX', 300, 'NX');
    return NextResponse.json({ nonce, message, expires });
  } catch { return NextResponse.json({ error: 'Shared challenge store unavailable' }, { status: 503 }); }
}
