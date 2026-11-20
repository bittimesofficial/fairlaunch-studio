import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getAddress, isAddress, type Address } from 'viem';
import { metadataSchema } from '@/lib/validation';
import { updateJson } from '@/lib/storage';

export const runtime = 'nodejs';
export type SavedMetadata = { id: string; created: string; creator?: Address; uri?: string; input: ReturnType<typeof metadataSchema.parse>; token?: string; chainId?: number };
type Store = Record<string, SavedMetadata>;
const hits = new Map<string, number[]>();
export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'New token metadata hosting is unavailable on this deployment' }, { status: 503 });
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  if (recent.length >= 12) return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  recent.push(now); hits.set(ip, recent);
  if (Number(request.headers.get('content-length') || 0) > 3_000_000) return NextResponse.json({ error: 'File too large' }, { status: 413 });
  let input; let creator: Address;
  try { const body = await request.json(); input = metadataSchema.parse(body); if (!isAddress(body.creator)) throw new Error('Invalid creator'); creator = getAddress(body.creator); }
  catch { return NextResponse.json({ error: 'Invalid token metadata' }, { status: 400 }); }
  const configuredOrigin = process.env.NEXT_PUBLIC_APP_ORIGIN;
  const id = randomUUID();
  const uri = `${configuredOrigin || request.nextUrl.origin}/api/metadata/${id}`;
  const item: SavedMetadata = { id, created: new Date().toISOString(), creator, uri, input };
  try { await updateJson<Store>('metadata.json', {}, store => { store[item.id] = item; }); }
  catch { return NextResponse.json({ error: 'Storage unavailable' }, { status: 503 }); }
  return NextResponse.json({ id, uri }, { status: 201 });
}
