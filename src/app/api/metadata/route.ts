import { NextRequest, NextResponse } from 'next/server';
import { createHash, randomUUID } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address } from 'viem';
import { put } from '@vercel/blob';
import sharp from 'sharp';
import { metadataSchema } from '../../../lib/validation';
import { durableReady, limit, redis } from '../../../lib/durable';
import { boundedJson } from '../../../lib/request-body';

export const runtime = 'nodejs';
export type SavedMetadata = { id: string; created: string; creator: Address; uri: string; input: ReturnType<typeof metadataSchema.parse> };
const bad = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(request: NextRequest) {
  if (!durableReady() || !process.env.NEXT_PUBLIC_APP_ORIGIN?.startsWith('https://')) return bad('Permanent metadata service is not configured', 503);
  if (request.headers.get('origin') !== process.env.NEXT_PUBLIC_APP_ORIGIN) return bad('Origin mismatch', 403);
  if (Number(request.headers.get('content-length') || 0) > 3_000_000) return bad('File too large', 413);
  let body: Record<string, unknown>; let input: ReturnType<typeof metadataSchema.parse>;
  try { body = await boundedJson(request, 3_000_000) as Record<string, unknown>; input = metadataSchema.parse(body); }
  catch { return bad('Invalid token metadata', 400); }
  if (typeof body.nonce !== 'string' || !/^[0-9a-f-]{36}$/.test(body.nonce) || typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature) || typeof body.creator !== 'string' || !isAddress(body.creator)) return bad('Invalid wallet proof', 400);
  const creator = getAddress(body.creator as string);
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const idempotency = createHash('sha256').update(`${creator}:${digest}`).digest('hex');
  try {
    const challenge = await redis<string>('GETDEL', `fairlaunch:nonce:${body.nonce}`);
    if (!challenge) return bad('Challenge expired or already used', 401);
    const [expectedCreator, expectedDigest, message] = JSON.parse(challenge) as [string, string, string];
    if (expectedCreator !== creator || expectedDigest !== digest || !(await verifyMessage({ address: creator, message, signature: body.signature as `0x${string}` }))) return bad('Invalid wallet signature', 401);
    const existing = await redis<string>('GET', `fairlaunch:idem:${idempotency}`);
    if (existing && existing !== 'PROCESSING') {
      const saved = JSON.parse(existing) as SavedMetadata;
      const readback = await fetch(saved.uri, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      const imageReadback = saved.input.image ? await fetch(saved.input.image, { cache: 'no-store', signal: AbortSignal.timeout(8000) }) : null;
      if (readback.status !== 200 || imageReadback?.status !== 200) throw new Error('Stored metadata readback unavailable');
      const data = await readback.json();
      if (data.name !== saved.input.name || data.symbol !== saved.input.symbol || data.image !== saved.input.image || data.chainId !== 91342) throw new Error('Stored metadata readback mismatch');
      return NextResponse.json({ id: saved.id, uri: saved.uri, reused: true });
    }
    const ip = request.headers.get('x-vercel-forwarded-for') || request.headers.get('x-real-ip') || 'unknown';
    if (!(await limit(`ip:${ip}`, 10, 3600)) || !(await limit(`wallet:${creator}`, 2, 86400)) || !(await limit('global-upload', 30, 86400))) return bad('Upload limit exceeded', 429);
    const acquired = await redis<string>('SET', `fairlaunch:idem:${idempotency}`, 'PROCESSING', 'NX', 'EX', 600);
    if (acquired !== 'OK') return bad('Metadata upload already in progress; retry with a fresh wallet challenge later', 409);
    if (!input.image) return bad('Image required', 400);
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(input.image);
    if (!match) return bad('Invalid image', 400);
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length > 2_000_000 || bytes.length < 12 || bytes.toString('base64') !== match[2]) return bad('Invalid image size or encoding', 400);
    const imageInfo = await sharp(bytes, { failOn: 'error', limitInputPixels: 16_000_000 }).metadata();
    if (imageInfo.format !== match[1] || !imageInfo.width || !imageInfo.height) return bad('Image content does not match MIME', 400);
    const clean = await sharp(bytes).rotate().resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (clean.length > 2_000_000) return bad('Encoded image exceeds storage limit', 413);
    const id = randomUUID();
    const image = await put(`tokens/${id}/image.webp`, clean, { access: 'public', contentType: 'image/webp', addRandomSuffix: false, allowOverwrite: false });
    const metadata = { name: input.name, symbol: input.symbol, description: input.description, category: input.category, image: image.url, website: input.website, x: input.x, telegram: input.telegram, discord: input.discord, chainId: 91342 };
    const blob = await put(`tokens/${id}/metadata.json`, JSON.stringify(metadata), { access: 'public', contentType: 'application/json', addRandomSuffix: false, allowOverwrite: false });
    if (!blob.url.startsWith('https://') || !image.url.startsWith('https://')) throw new Error('Non-HTTPS storage URI');
    const [metadataRead, imageRead] = await Promise.all([fetch(blob.url, { cache: 'no-store', signal: AbortSignal.timeout(8000) }), fetch(image.url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })]);
    if (metadataRead.status !== 200 || imageRead.status !== 200 || JSON.stringify(await metadataRead.json()) !== JSON.stringify(metadata) || !imageRead.headers.get('content-type')?.startsWith('image/webp')) throw new Error('Permanent metadata or image readback failed');
    const saved: SavedMetadata = { id, created: new Date().toISOString(), creator, uri: blob.url, input: { ...input, image: image.url } };
    await redis('SET', `fairlaunch:metadata:${id}`, JSON.stringify(saved));
    await redis('SET', `fairlaunch:idem:${idempotency}`, JSON.stringify(saved));
    return NextResponse.json({ id, uri: blob.url }, { status: 201 });
  } catch { return bad('Permanent metadata unavailable or verification failed', 503); }
}
