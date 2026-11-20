import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { previewAmmoraLiquidityMigrationFee } from '@ammora-protocol/sdk';

const load = name => JSON.parse(readFileSync(new URL(`../fixtures/onchain/${name}`, import.meta.url)));
const terminal = load('local-fork-terminal-2026-11-19T04-20-04.169Z.json');
const audit = load('local-fork-migration-audit-2026-11-19T04-26-35.384Z.json');
const big = value => BigInt(value);

test('local fork terminal buy refunds only unused WETH and leaves a residual allowance', () => {
  const before = terminal.afterRevert;
  const after = terminal.overshoot.state;
  const event = terminal.overshoot.event;
  expect(big(event.requestedAmountIn)).toBe(big(event.consumedAmountIn) + big(event.amountLeft));
  expect(big(before.buyerWeth) - big(after.buyerWeth)).toBe(big(event.consumedAmountIn));
  expect(big(after.allowanceWeth)).toBe(big(event.amountLeft));
  expect(after.progress.ready).toBe(true);
  expect(after.progress.migrated).toBe(false);
});

test('local migration reconciles both asset fees, fee vault, dust and LP lock', () => {
  const before = terminal.overshoot.state;
  const after = terminal.migration.state;
  const b = audit.balances;
  const grossBase = big(before.curve.baseReserve) - big(after.curve.baseReserve);
  const grossQuote = big(before.curve.quoteReserve);
  expect(grossBase).toBe(123502500000000n);
  expect(big(b.curve.base.delta) + big(b.pool.base.delta) + big(b.feeVault.base.delta)).toBe(0n);
  expect(big(b.curve.weth.delta) + big(b.pool.weth.delta) + big(b.feeVault.weth.delta)).toBe(0n);
  expect(big(terminal.migration.event.baseAmount)).toBe(previewAmmoraLiquidityMigrationFee(grossBase).amountAfterFee);
  expect(big(terminal.migration.event.quoteAmount)).toBe(previewAmmoraLiquidityMigrationFee(4940100000000000n).amountAfterFee);
  expect(big(b.feeVault.weth.delta)).toBe(grossQuote - big(terminal.migration.event.quoteAmount));
  expect(big(after.curve.baseReserve)).toBe(1235025000002n);
  expect(big(audit.lpAllocation.lockedLiquidity) * 10n).toBe(big(audit.lpAllocation.migratedLiquidity));
  expect(after.progress.migrated).toBe(true);
});
