import { describe, expect, it, vi } from 'vitest';
import { retryRead } from '../src/lib/rpc-read';
import { giwaWethAddress, wethPlan } from '../src/lib/weth';

describe('GIWA read retry and WETH wallet plans', () => {
  it('backs off only bounded read-only 429 failures', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('429 Too Many Requests')).mockRejectedValueOnce({ cause: { status: 429 } }).mockResolvedValue(63);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(retryRead(read, wait)).resolves.toBe(63);
    expect(read).toHaveBeenCalledTimes(3);
    expect(wait.mock.calls.map(args => args[0])).toEqual([1500, 3000]);
    const always429 = vi.fn().mockRejectedValue(new Error('eth_blockNumber: 429 Too Many Requests'));
    await expect(retryRead(always429, wait)).rejects.toThrow('429');
    expect(always429).toHaveBeenCalledTimes(3);
    const other = vi.fn().mockRejectedValue(new Error('execution reverted'));
    await expect(retryRead(other, wait)).rejects.toThrow('reverted');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('builds only exact GIWA WETH deposit and withdraw, preserving gas reserve', () => {
    const wrap = wethPlan('Wrap', 10_000_000_000_000n, 200_000_000_000_000n, 0n);
    expect(wrap).toEqual({ to: giwaWethAddress, data: '0xd0e30db0', value: 10_000_000_000_000n });
    const unwrap = wethPlan('Unwrap', 10_000_000_000_000n, 0n, 10_000_000_000_000n);
    expect(unwrap.to).toBe(giwaWethAddress);
    expect(unwrap.data).toMatch(/^0x2e1a7d4d[0-9a-f]{64}$/);
    expect(unwrap.value).toBe(0n);
    expect(() => wethPlan('Wrap', 10_000_000_000_000n, 100_000_000_000_000n, 0n)).toThrow('gas');
    expect(() => wethPlan('Unwrap', 2n, 0n, 1n)).toThrow('Insufficient');
  });
});
