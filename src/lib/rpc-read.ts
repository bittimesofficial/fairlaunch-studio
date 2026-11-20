export function isRateLimited(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current; depth++) {
    if (typeof current === 'object') {
      const item = current as { status?: number; statusCode?: number; code?: number; message?: string; shortMessage?: string; cause?: unknown };
      if (item.status === 429 || item.statusCode === 429 || item.code === 429 || /429|too many requests|rate limit/i.test(`${item.shortMessage || ''} ${item.message || ''}`)) return true;
      current = item.cause;
    } else break;
  }
  return false;
}

export async function retryRead<T>(read: () => Promise<T>, wait: (ms: number) => Promise<unknown> = ms => new Promise(resolve => setTimeout(resolve, ms))): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await read(); }
    catch (error) {
      if (attempt >= 2 || !isRateLimited(error)) throw error;
      await wait(1_500 * (attempt + 1));
    }
  }
}
