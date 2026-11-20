import { NextResponse } from 'next/server';
import { getCatalog } from '@/lib/catalog';
export const runtime = 'nodejs';
export async function GET() {
  try { return NextResponse.json(await getCatalog(), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : 'RPC unavailable' }, { status: 503 }); }
}
