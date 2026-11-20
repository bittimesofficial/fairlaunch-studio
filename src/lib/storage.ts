import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = join(process.cwd(), 'data');
const mutations = new Map<string, Promise<void>>();
export async function readJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(join(directory, name), 'utf8')) as T; }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return fallback;
    throw error;
  }
}
export async function writeJson(name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `${name}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(value), 'utf8');
  await rename(temp, join(directory, name));
}
export async function updateJson<T>(name: string, fallback: T, change: (value: T) => void): Promise<void> {
  const previous = mutations.get(name) || Promise.resolve();
  const current = previous.then(async () => {
    const value = await readJson(name, fallback);
    change(value);
    await writeJson(name, value);
  });
  mutations.set(name, current.catch(() => {}));
  await current;
}
