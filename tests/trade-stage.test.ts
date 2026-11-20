import { expect, test } from 'vitest';
import { assertFullV4Fill, assertMarketStage } from '../src/lib/trading';
import { approvalNeedsUpdate } from '../src/lib/browser';

const zero = '0x0000000000000000000000000000000000000000';
const pool = '0x0000000000000000000000000000000000001234';

test('rejects curve-to-pool transition and changed graduated pool before planning', () => {
  expect(() => assertMarketStage(false, false, zero, zero)).not.toThrow();
  expect(() => assertMarketStage(false, true, zero, pool)).toThrow('Market stage changed');
  expect(() => assertMarketStage(true, false, pool, zero)).toThrow('Market stage changed');
  expect(() => assertMarketStage(true, true, pool, zero)).toThrow('Market stage changed');
});

test('V4 partial terminal fill stays blocked and stale approval is reduced to exact amount', () => {
  expect(() => assertFullV4Fill(0n, false)).not.toThrow();
  expect(() => assertFullV4Fill(1n, false)).toThrow('graduation boundary');
  expect(() => assertFullV4Fill(1n, true)).toThrow('Partial sell');
  expect(approvalNeedsUpdate(1_770_814_514_142_255n, 10_000_000_000_000n)).toBe(true);
  expect(approvalNeedsUpdate(10_000_000_000_000n, 10_000_000_000_000n)).toBe(false);
});
