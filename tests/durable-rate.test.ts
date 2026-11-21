import { afterEach, expect, test, vi } from 'vitest';
import { limit } from '../src/lib/durable';

afterEach(() => { vi.unstubAllGlobals(); delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; });

test('shared atomic counter enforces limit across requests and fails closed on outage', async () => {
  process.env.KV_REST_API_URL = 'https://test.upstash.io';
  process.env.KV_REST_API_TOKEN = 'test-only';
  let count = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    const command = JSON.parse(String(init.body));
    expect(command[0]).toBe('EVAL');
    expect(command[3]).toBe('fairlaunch:limit:wallet:test');
    return new Response(JSON.stringify({ result: ++count }), { status: 200 });
  }));
  expect(await limit('wallet:test', 2, 60)).toBe(true);
  expect(await limit('wallet:test', 2, 60)).toBe(true);
  expect(await limit('wallet:test', 2, 60)).toBe(false);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
  await expect(limit('wallet:test', 2, 60)).rejects.toThrow('offline');
});
