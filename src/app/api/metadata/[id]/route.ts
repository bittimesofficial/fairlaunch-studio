import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/durable';
import type { SavedMetadata } from '../route';
export const runtime = 'nodejs';
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  let item: SavedMetadata | undefined;
  try { const raw = await redis<string>('GET', `fairlaunch:metadata:${id}`); item = raw ? JSON.parse(raw) as SavedMetadata : undefined; }
  catch { return NextResponse.json({ error: 'Shared metadata store unavailable' }, { status: 503 }); }
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ name: item.input.name, symbol: item.input.symbol, description: item.input.description, category: item.input.category, image: item.input.image || null, website: item.input.website, x: item.input.x, telegram: item.input.telegram, discord: item.input.discord, chainId: 91342 }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
