import { expect, test, vi } from 'vitest';

const factory = '0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA';
const fltestToken = '0x4362c5575918c819122f1A76510130337320cd9C';
const owner = '0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5';
const nextToken = '0x0000000000000000000000000000000000000123';
const hash = `0x${'a'.repeat(64)}`;
const metadataURI = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
const database = new Map<string, string>();
vi.mock('../src/lib/chain', () => ({
  factory, segmentedALCLaunchFactoryV3Abi: [], publicClient: {
    getBlockNumber: async () => 700n,
    getTransactionReceipt: async ({ hash: requested }: { hash: string }) => ({ status: 'success', to: factory, blockNumber: requested === hash ? 120n : 100n, blockHash: requested === hash ? `0x${'2'.repeat(64)}` : `0x${'1'.repeat(64)}`, logs: requested === hash ? [] : [{ address: factory }] }),
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({ hash: blockNumber === 100n ? `0x${'1'.repeat(64)}` : blockNumber === 120n ? `0x${'2'.repeat(64)}` : `0x${'3'.repeat(64)}` }),
    getLogs: async () => [{ address: factory, transactionHash: hash, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 120n }],
  },
}));
vi.mock('viem', async importOriginal => {
  const original = await importOriginal<typeof import('viem')>();
  return { ...original, parseEventLogs: ({ logs }: { logs: { transactionHash?: string }[] }) => logs[0]?.transactionHash ? [{ args: { token: nextToken, curve: nextToken, creator: owner, configId: 63n, metadataURI: 'https://example.org/new.json' }, transactionHash: hash, blockHash: `0x${'2'.repeat(64)}`, blockNumber: 120n }] : [{ args: { token: fltestToken, curve: nextToken, creator: owner, configId: 63n, metadataURI } }] };
});
vi.mock('../src/lib/durable', () => ({ redis: async (...args: (string | number)[]) => {
  const [command, key, value] = args;
  if (command === 'GET') return database.get(String(key)) ?? null;
  if (command === 'HVALS') return [];
  if (command === 'SET') { database.set(String(key), String(value)); return 'OK'; }
  if (command === 'EVAL') { if (args.length > 6) database.set('fairlaunch:catalog:v1', String(args[6])); return 1; }
  return null;
} }));

test('indexes a new final Factory event and persists scan cursor alongside FLTEST', async () => {
  process.env.KV_REST_API_URL = 'https://test.upstash.io';
  process.env.KV_REST_API_TOKEN = 'test';
  const { getCatalog } = await import('../src/lib/catalog');
  const catalog = await getCatalog();
  expect(catalog.launches.map(item => item.token.toLowerCase())).toContain(fltestToken.toLowerCase());
  expect(catalog.launches.map(item => item.token.toLowerCase())).toContain(nextToken.toLowerCase());
  expect(catalog.nextBlock).toBe('601');
  expect(database.has('fairlaunch:catalog:v1')).toBe(true);
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
});
