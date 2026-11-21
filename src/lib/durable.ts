// Server-only, fail-closed shared state. No credential is exposed to the browser.
export function durableReady() {
  return !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN && process.env.BLOB_READ_WRITE_TOKEN);
}

export async function redis<T = unknown>(...command: (string | number)[]): Promise<T> {
  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token || !/^https:\/\//.test(url)) throw new Error('Shared storage is not configured');
  const response = await fetch(url, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command), cache: 'no-store', signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error('Shared storage unavailable');
  const data = await response.json() as { result?: T; error?: string };
  if (data.error) throw new Error('Shared storage command failed');
  return data.result as T;
}

export async function limit(key: string, max: number, seconds: number) {
  const script = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n";
  const count = await redis<number>('EVAL', script, 1, `fairlaunch:limit:${key}`, seconds);
  return count <= max;
}
