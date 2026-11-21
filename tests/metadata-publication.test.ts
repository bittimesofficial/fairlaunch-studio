import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { privateKeyToAccount } from 'viem/accounts';
import sharp from 'sharp';

const state = vi.hoisted(() => ({ records: new Map<string, string>(), blobs: new Map<string, { body: string | Buffer; type: string }>(), writes: 0 }));
vi.mock('../src/lib/durable', () => ({
  durableReady: () => true,
  limit: async () => true,
  redis: async (...args: (string | number)[]) => {
    const [command, key, value, ...rest] = args;
    if (command === 'GET') return state.records.get(String(key)) ?? null;
    if (command === 'GETDEL') { const result = state.records.get(String(key)) ?? null; state.records.delete(String(key)); return result; }
    if (command === 'SET') {
      if (rest.includes('NX') && state.records.has(String(key))) return null;
      state.records.set(String(key), String(value)); return 'OK';
    }
    throw new Error('Unexpected Redis command');
  },
}));
vi.mock('@vercel/blob', () => ({ put: async (path: string, body: string | Buffer, options: { contentType: string }) => {
  state.writes++;
  const url = `https://test.public.blob.vercel-storage.com/${path}`;
  state.blobs.set(url, { body, type: options.contentType });
  return { url };
} }));

import { POST as challenge } from '../src/app/api/metadata/challenge/route';
import { POST as publish } from '../src/app/api/metadata/route';
import { metadataSchema } from '../src/lib/validation';

const origin = 'https://fairlaunch-studio.vercel.app';
const account = privateKeyToAccount(`0x${'1'.padStart(64, '0')}`);
function request(path: string, body: unknown) { return new NextRequest(`${origin}${path}`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
beforeEach(() => {
  state.records.clear(); state.blobs.clear(); state.writes = 0;
  process.env.NEXT_PUBLIC_APP_ORIGIN = origin;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const blob = state.blobs.get(String(url));
    return blob ? new Response(typeof blob.body === 'string' ? blob.body : blob.body.toString('base64'), { status: 200, headers: { 'content-type': blob.type } }) : new Response('', { status: 404 });
  }));
});
afterEach(() => { vi.unstubAllGlobals(); delete process.env.NEXT_PUBLIC_APP_ORIGIN; });

test('wallet bound metadata upload persists image and immutable JSON; replay and ownership fail', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff0000' } }).png().toBuffer();
  const input = metadataSchema.parse({ name: 'Test Token', symbol: 'TEST', description: 'Test', category: 'Product & Utility', website: '', x: '', telegram: '', discord: '', image: `data:image/png;base64,${png.toString('base64')}` });
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const challengeResponse = await challenge(request('/api/metadata/challenge', { creator: account.address, digest }));
  expect(challengeResponse.status).toBe(200);
  const { nonce, message } = await challengeResponse.json();
  const signature = await account.signMessage({ message });
  const payload = { ...input, creator: account.address, nonce, signature };
  const wrong = await publish(request('/api/metadata', { ...payload, creator: '0x0000000000000000000000000000000000000002' }));
  expect(wrong.status).toBe(401);
  expect((await publish(request('/api/metadata', payload))).status).toBe(401);
  const fresh = await (await challenge(request('/api/metadata/challenge', { creator: account.address, digest }))).json();
  const uploaded = await publish(request('/api/metadata', { ...payload, nonce: fresh.nonce, signature: await account.signMessage({ message: fresh.message }) }));
  expect(uploaded.status).toBe(201);
  const result = await uploaded.json();
  expect(result.uri).toMatch(/^https:\/\/.+\/metadata\.json$/);
  expect(state.writes).toBe(2);
  const metadata = JSON.parse(String(state.blobs.get(result.uri)?.body));
  expect(metadata.image).toMatch(/^https:\/\/.+\/image\.webp$/);
  expect(state.blobs.get(metadata.image)?.type).toBe('image/webp');
  const retry = await (await challenge(request('/api/metadata/challenge', { creator: account.address, digest }))).json();
  const reused = await publish(request('/api/metadata', { ...payload, nonce: retry.nonce, signature: await account.signMessage({ message: retry.message }) }));
  expect(reused.status).toBe(200);
  expect((await reused.json()).uri).toBe(result.uri);
  expect(state.writes).toBe(2);
});

test('rejects image MIME spoofing before any Blob write', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#0000ff' } }).png().toBuffer();
  const input = metadataSchema.parse({ name: 'Spoof Test', symbol: 'SPF', description: '', category: 'Meme & Community', website: '', x: '', telegram: '', discord: '', image: `data:image/jpeg;base64,${png.toString('base64')}` });
  const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const { nonce, message } = await (await challenge(request('/api/metadata/challenge', { creator: account.address, digest }))).json();
  const response = await publish(request('/api/metadata', { ...input, creator: account.address, nonce, signature: await account.signMessage({ message }) }));
  expect(response.status).toBe(400);
  expect(state.writes).toBe(0);
});

test('rejects oversized challenge requests before Redis writes', async () => {
  const response = await challenge(request('/api/metadata/challenge', { creator: account.address, digest: 'a'.repeat(64), padding: 'x'.repeat(1024) }));
  expect(response.status).toBe(400);
  expect(state.records.size).toBe(0);
});
