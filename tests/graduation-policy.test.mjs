import { expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { concentratedDepositQuote, maxBaseOutput } from '@ammora-protocol/sdk';
import { deriveConcentratedPolicy } from '../scripts/graduation-policy.mjs';

const raw = JSON.parse(readFileSync(new URL('../fixtures/onchain/v4-2026-11-19T03-22-49-180Z.json', import.meta.url)));
const numeric = value => Array.isArray(value) ? value.map(numeric) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, numeric(v)])) : typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : value;
const template = numeric(raw.configs['10'].snapshot.config);
// Small ABI integer fields are JavaScript numbers in SDK snapshots.
for (const key of ['tokenDecimals', 'cliffFeeBps', 'creatorShareOfNonProtocolBps', 'feeNumberOfPeriods', 'feePeriodFrequency', 'feeReductionFactorBps', 'feeSchedulerMode', 'rateLimiterFeeIncrementBps', 'rateLimiterDuration', 'dynamicFeeBinStepBps', 'dynamicFeeFilterPeriod', 'dynamicFeeDecayPeriod', 'dynamicFeeReductionFactorBps', 'collectFeeMode', 'migrationQuoteFeeBps', 'creatorMigrationFeeShareBps', 'postMigrationFeeBps', 'postMigrationCompoundingFeeBps', 'postMigrationCollectFeeMode', 'migrationMode', 'postMigrationFeeNumberOfPeriods', 'postMigrationFeePeriodFrequency', 'postMigrationFeeReductionFactorBps', 'postMigrationFeeSchedulerMode', 'activationDelay', 'activationType']) template[key] = Number(template[key]);
for (const key of ['partnerUnlockedBps', 'partnerPermanentLockedBps', 'creatorPermanentLockedBps']) template.liquidityDistribution[key] = Number(template.liquidityDistribution[key]);
for (const section of ['partnerVesting', 'creatorVesting']) for (const key of Object.keys(template.liquidityDistribution[section])) template.liquidityDistribution[section][key] = Number(template.liquidityDistribution[section][key]);
template.lockedBaseVesting.numberOfPeriods = Number(template.lockedBaseVesting.numberOfPeriods);
const addresses = { partnerRecipient: '0x1111111111111111111111111111111111111111', liquidityPartner: '0x2222222222222222222222222222222222222222', leftoverReceiver: '0x3333333333333333333333333333333333333333' };

test('Config #6 terminal curve sale leaves insufficient base for concentrated migration', () => {
  const source = raw.configs['6'].snapshot;
  const c = numeric(source.config);
  const segments = numeric(source.segments);
  const sold = maxBaseOutput(segments, c.startSqrtPrice);
  const destination = concentratedDepositQuote({ sqrtPriceX64: segments.at(-1).upperSqrtPrice, sqrtMinPriceX64: c.postMigrationSqrtMinPrice, sqrtMaxPriceX64: c.postMigrationSqrtMaxPrice }, { quoteAmount: c.migrationQuoteThreshold });
  expect(sold).toBe(1000000000000000000n);
  expect(destination.baseAmount).toBe(333333333342095747n);
  expect(c.totalSupply - sold).toBe(0n);
  expect(c.migrationBaseThreshold).toBe(0n);
});

test('derived concentrated Config reserves worst-case base, fees, and quote with margin', () => {
  const { config, economics } = deriveConcentratedPolicy(template, 1000000000000000n, 5000000000000000n, addresses);
  expect(config.totalSupply).toBe(economics.worstCaseCurveBaseSoldRaw + economics.grossMigrationBaseRaw + economics.lockedBaseRaw + economics.baseSafetyBufferRaw);
  expect(economics.grossMigrationQuoteRaw + economics.quoteSurplusRaw).toBe(5000000000000000n);
  expect(economics.grossMigrationBaseRaw - economics.protocolMigrationBaseFeeRaw).toBe(economics.netPoolBaseRaw);
  expect(economics.grossMigrationQuoteRaw - economics.protocolMigrationQuoteFeeRaw).toBe(economics.netPoolQuoteRaw);
  expect(economics.baseSafetyBufferRaw).toBeGreaterThan(0n);
  expect(economics.quoteSurplusRaw).toBeGreaterThan(0n);
  expect(config.migrationBaseThreshold).toBeGreaterThan(0n);
});

test('invalid thresholds and recipient addresses fail closed', () => {
  expect(() => deriveConcentratedPolicy(template, 0n, 1n, addresses)).toThrow();
  expect(() => deriveConcentratedPolicy(template, 1n, 0n, addresses)).toThrow();
  expect(() => deriveConcentratedPolicy(template, 1000000000000000n, 5000000000000000n, { ...addresses, leftoverReceiver: '0x0000000000000000000000000000000000000000' })).toThrow();
  expect(() => deriveConcentratedPolicy(template, 1000000000000000n, 500000000000000n, addresses)).toThrow(/initial price is too high/);
});
