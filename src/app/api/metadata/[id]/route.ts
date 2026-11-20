import { NextRequest, NextResponse } from 'next/server';
import { readJson } from '@/lib/storage';
import type { SavedMetadata } from '../route';
export const runtime = 'nodejs';
export async function GET(_request: NextRequest, context: { params: Promise<{ id: string }> }) {
  if (process.env.NODE_ENV === 'production') return NextResponse.json({ error: 'Local metadata is unavailable on this deployment' }, { status: 410 });
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const item = (await readJson<Record<string, SavedMetadata>>('metadata.json', {}))[id];
  if (!item) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ name: item.input.name, symbol: item.input.symbol, description: item.input.description, category: item.input.category, image: item.input.image || null, website: item.input.website, x: item.input.x, telegram: item.input.telegram, discord: item.input.discord, chainId: item.chainId || null, token: item.token || null }, { headers: { 'Cache-Control': 'public, max-age=60' } });
}
