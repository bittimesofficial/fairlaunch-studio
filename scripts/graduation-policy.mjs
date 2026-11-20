import {
  assertAmmoraV4Config, buildSingleSegmentCurve, concentratedDepositQuote,
  maxBaseOutput, previewAmmoraLiquidityMigrationFee,
} from '@ammora-protocol/sdk';

// Mirrors the official ammora-examples concentrated template derivation. Every
// reserve is a raw bigint; the SDK supplies the curve and pool math.
export function deriveConcentratedPolicy(template, saleSupplyRaw, quoteThresholdRaw, recipients) {
  if (saleSupplyRaw <= 0n || quoteThresholdRaw <= 0n) throw new RangeError('Positive sale and quote threshold required');
  if (template.migrationMode !== 0) throw new Error('Concentrated template required');
  for (const key of ['partnerRecipient', 'liquidityPartner', 'leftoverReceiver']) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipients[key]) || /^0x0{40}$/i.test(recipients[key])) throw new Error(`${key} must be a nonzero public address`);
  }
  const curve = buildSingleSegmentCurve(template.startSqrtPrice, saleSupplyRaw, quoteThresholdRaw);
  const segment = curve[0];
  const range = { sqrtPriceX64: segment.upperSqrtPrice, sqrtMinPriceX64: segment.lowerSqrtPrice, sqrtMaxPriceX64: segment.upperSqrtPrice * 2n };
  const configQuoteFee = quoteThresholdRaw * BigInt(template.migrationQuoteFeeBps) / 10000n;
  const afterConfigFee = quoteThresholdRaw - configQuoteFee;
  // Size below the entire threshold's post-fee quote as a conservative budget.
  // The actual Manager fee is assessed on the gross amount sent to migration.
  const thresholdSizingFee = previewAmmoraLiquidityMigrationFee(afterConfigFee);
  const destinationQuoteBudget = thresholdSizingFee.amountAfterFee * 99n / 100n;
  const destination = concentratedDepositQuote(range, { quoteAmount: destinationQuoteBudget });
  const migrationBaseFee = previewAmmoraLiquidityMigrationFee(destination.baseAmount);
  const migrationQuoteFee = previewAmmoraLiquidityMigrationFee(destination.quoteAmount);
  const vesting = template.lockedBaseVesting;
  const lockedBaseRaw = vesting.cliffUnlockAmount + vesting.amountPerPeriod * BigInt(vesting.numberOfPeriods);
  const worstCaseCurveBaseSoldRaw = maxBaseOutput(curve, template.startSqrtPrice);
  const baseSafetyBufferRaw = (destination.baseAmount + 99n) / 100n;
  const totalSupply = worstCaseCurveBaseSoldRaw + destination.baseAmount + lockedBaseRaw + baseSafetyBufferRaw;
  const config = {
    ...template,
    partnerRecipient: recipients.partnerRecipient,
    leftoverReceiver: recipients.leftoverReceiver,
    liquidityDistribution: { ...template.liquidityDistribution, partner: recipients.liquidityPartner },
    totalSupply,
    migrationQuoteThreshold: quoteThresholdRaw,
    migrationBaseThreshold: destination.baseAmount,
    postMigrationSqrtMinPrice: range.sqrtMinPriceX64,
    postMigrationSqrtMaxPrice: range.sqrtMaxPriceX64,
    postMigrationLiquidity: destination.liquidity,
  };
  assertAmmoraV4Config(config, curve);
  if (totalSupply < worstCaseCurveBaseSoldRaw + destination.baseAmount + lockedBaseRaw || destination.baseAmount <= 0n || destination.quoteAmount <= 0n || destination.liquidity <= 0n) throw new Error('Insufficient migration inventory');
  if (thresholdSizingFee.amountAfterFee < destination.quoteAmount || afterConfigFee <= 0n || migrationBaseFee.amountAfterFee <= 0n || migrationQuoteFee.amountAfterFee <= 0n) throw new Error('Insufficient migration reserves');
  return { config, curve, economics: {
    saleSupplyRaw, worstCaseCurveBaseSoldRaw, grossMigrationBaseRaw: destination.baseAmount, baseSafetyBufferRaw,
    grossMigrationQuoteRaw: destination.quoteAmount, configQuoteFeeRaw: configQuoteFee,
    thresholdSizingFeeRaw: thresholdSizingFee.protocolFee,
    protocolMigrationBaseFeeRaw: migrationBaseFee.protocolFee, protocolMigrationQuoteFeeRaw: migrationQuoteFee.protocolFee,
    netPoolBaseRaw: migrationBaseFee.amountAfterFee, netPoolQuoteRaw: migrationQuoteFee.amountAfterFee,
    quoteSurplusRaw: quoteThresholdRaw - destination.quoteAmount,
    lockedBaseRaw, totalSupplyRaw: totalSupply,
  } };
}
