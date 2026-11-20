import { afterEach, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readJson, updateJson } from '../src/lib/storage';

const name = `storage-test-${randomUUID()}.json`;
const path = join(process.cwd(), 'data', name);
afterEach(async () => { await rm(path, { force: true }); });

test('serializes metadata changes and recovers after a rejected change', async () => {
  await Promise.all(Array.from({ length: 12 }, (_, index) => updateJson<number[]>(name, [], values => { values.push(index); })));
  expect((await readJson<number[]>(name, [])).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, index) => index));
  await expect(updateJson<number[]>(name, [], () => { throw new Error('rejected'); })).rejects.toThrow('rejected');
  await updateJson<number[]>(name, [], values => { values.push(12); });
  expect((await readJson<number[]>(name, [])).length).toBe(13);
});

test('rejects corrupt JSON instead of overwriting it', async () => {
  await updateJson(name, [] as number[], () => {});
  await writeFile(path, '{broken', 'utf8');
  await expect(updateJson<number[]>(name, [], values => { values.push(1); })).rejects.toThrow();
  expect(await readFile(path, 'utf8')).toBe('{broken');
});
