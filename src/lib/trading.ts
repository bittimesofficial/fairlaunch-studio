import { AmmoraSwapClient, AmmoraV4LaunchCurveClient, classifyAmmoraV4ExactInputFill, getAmmoraV4ConfigAtBlock, giwaSepoliaAutoRouteDeploymentCatalog, giwaSepoliaAutoRoutePoolProfiles } from '@ammora-protocol/sdk';
import { zeroAddress, type Address, type Hex } from 'viem';
import type { Launch } from './catalog';
import { deployment, factory, publicClient, registry } from './chain';

type CurveState = Awaited<ReturnType<AmmoraV4LaunchCurveClient['getStateAtBlock']>>;
export type TradePlan = {
  quote: { amountOut: bigint; minimumAmountOut: bigint; fee: bigint; priceImpactBps?: bigint };
  transaction: { to: Address; data: Hex; value?: bigint };
  approvalRequirement: { token: Address; spender: Address; amount: bigint };
  routeTarget: Address;
};

export function v4Curve(address: Address): AmmoraV4LaunchCurveClient {
  return new AmmoraV4LaunchCurveClient(publicClient, address, { launchFactory: factory, feePolicy: deployment.contracts.launch.feePolicy });
}

export function assertMarketStage(expectedGraduated: boolean, liveGraduated: boolean, expectedPool: Address, livePool: Address): void {
  if (expectedGraduated !== liveGraduated || (liveGraduated && expectedPool.toLowerCase() !== livePool.toLowerCase())) {
    throw new Error('Market stage changed; refresh token page and quote');
  }
}

export function assertFullV4Fill(amountLeft: bigint, baseForQuote: boolean): void {
  if (amountLeft > 0n) throw new Error(baseForQuote ? 'Partial sell is unavailable; refresh the quote' : 'Buy crosses the graduation boundary; enter a smaller amount and refresh');
}

export async function prepareTrade(launch: Launch, state: CurveState, graduated: boolean, side: 'Buy' | 'Sell', amount: bigint, slippageBps: number, recipient: Address): Promise<TradePlan> {
  if (amount <= 0n || slippageBps < 1 || slippageBps > 1000) throw new Error('Invalid amount or slippage');
  const curve = v4Curve(launch.curve);
  const blockNumber = await publicClient.getBlockNumber();
  const [liveState, progress] = await Promise.all([curve.getStateAtBlock(blockNumber), curve.getMigrationProgressAtBlock(blockNumber)]);
  assertMarketStage(graduated, progress.migrated, state.canonicalPool, liveState.canonicalPool);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
  if (!graduated) {
    if (liveState.status !== 1 || progress.ready) throw new Error('Curve trading is not active');
    const plan = await curve.planSwapExactInput({ includedAmountIn: amount, baseForQuote: side === 'Sell', allowPartialFill: false, slippageBps, recipient, deadline });
    assertFullV4Fill(plan.quote.amountLeft, side === 'Sell');
    if (classifyAmmoraV4ExactInputFill(plan.quote, side === 'Sell').kind !== 'full') throw new Error('Curve fill needs a fresh quote');
    if (plan.quote.minimumAmountOut <= 0n || plan.transaction.to.toLowerCase() !== launch.curve.toLowerCase() || plan.approvalRequirement.spender.toLowerCase() !== launch.curve.toLowerCase() || plan.approvalRequirement.amount !== amount) throw new Error('Unexpected V4 curve plan');
    return { quote: { amountOut: plan.quote.amountOut, minimumAmountOut: plan.quote.minimumAmountOut, fee: plan.quote.fee }, transaction: plan.transaction, approvalRequirement: plan.approvalRequirement, routeTarget: launch.curve };
  }
  if (liveState.status !== 3 || liveState.canonicalPool.toLowerCase() === zeroAddress.toLowerCase()) throw new Error('Graduated pool is missing');
  const config = await getAmmoraV4ConfigAtBlock(publicClient, registry, BigInt(launch.configId), blockNumber);
  const mode = config.config.migrationMode;
  if (mode !== 0 && mode !== 1) throw new Error('Unsupported graduation mode');
  const model = mode === 0 ? 'concentrated' : 'compounding';
  const swap = await AmmoraSwapClient.create(publicClient, { deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
  const pool = liveState.canonicalPool;
  const tokenIn = side === 'Buy' ? liveState.quoteToken : liveState.baseToken;
  const prepared = await swap.prepareExactIn({ model, pool, tokenIn, amountIn: amount, payer: recipient, recipient, slippageBps, quoteBlockNumber: blockNumber });
  const quote = prepared.quote;
  if (prepared.isExpired() || quote.remainderAmountIn !== 0n || quote.minimumAmountOut <= 0n || prepared.transaction.to.toLowerCase() !== pool.toLowerCase() || prepared.approvalRequirements.length !== 1) throw new Error('Unexpected graduated trade plan');
  const approvalRequirement = prepared.approvalRequirements[0];
  if (approvalRequirement.token.toLowerCase() !== tokenIn.toLowerCase() || approvalRequirement.spender.toLowerCase() !== pool.toLowerCase() || approvalRequirement.amount !== amount) throw new Error('Unexpected graduated approval');
  return { quote: { amountOut: quote.expectedAmountOut, minimumAmountOut: quote.minimumAmountOut, fee: quote.feeAmount ?? 0n, priceImpactBps: quote.priceImpactBps ?? undefined }, transaction: prepared.transaction, approvalRequirement, routeTarget: pool };
}
