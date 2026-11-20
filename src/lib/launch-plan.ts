import { decodeAbiParameters, decodeFunctionData, getAddress, type Address, type Hex } from 'viem';
import { segmentedALCLaunchFactoryV3Abi } from '@ammora-protocol/sdk';

const firstBuyCallback = [{ type: 'tuple[]', components: [
  { name: 'includedQuoteAmount', type: 'uint256' },
  { name: 'minimumBaseAmountOut', type: 'uint256' },
  { name: 'allowPartialFill', type: 'bool' },
  { name: 'recipient', type: 'address' },
  { name: 'referrer', type: 'address' },
] }, { type: 'uint256' }] as const;

export function assertLaunchPlan(plan: { to: Address; data: Hex; value?: bigint }, expected: {
  factory: Address; name: string; symbol: string; uri: string; configId: bigint; decimals: number; fee: bigint;
  firstBuy?: { helper: Address; amount: bigint; minOut: bigint; recipient: Address; deadline: bigint };
}): void {
  if (getAddress(plan.to) !== getAddress(expected.factory) || plan.value !== expected.fee) throw new Error('Launch target or creation fee mismatch');
  const decoded = decodeFunctionData({ abi: segmentedALCLaunchFactoryV3Abi, data: plan.data });
  const args = decoded.args;
  if (!args || args[0] !== expected.name || args[1] !== expected.symbol || args[2] !== expected.uri || args[3] !== expected.uri ||
      args[4] !== expected.configId || args[5] !== expected.decimals) throw new Error('Launch calldata mismatch');
  if (!expected.firstBuy) {
    if (decoded.functionName !== 'createLaunchWithTokenConfig') throw new Error('Unexpected launch function');
    return;
  }
  if (decoded.functionName !== 'createLaunchAndCall' || getAddress(args[6] as Address) !== getAddress(expected.firstBuy.helper)) throw new Error('Unexpected first-buy helper');
  const [buys, deadline] = decodeAbiParameters(firstBuyCallback, args[7] as Hex);
  if (buys.length !== 1 || buys[0].includedQuoteAmount !== expected.firstBuy.amount || buys[0].minimumBaseAmountOut !== expected.firstBuy.minOut ||
      buys[0].allowPartialFill || getAddress(buys[0].recipient) !== getAddress(expected.firstBuy.recipient) ||
      getAddress(buys[0].referrer) !== '0x0000000000000000000000000000000000000000' ||
      deadline !== expected.firstBuy.deadline || deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Error('First-buy calldata mismatch');
}
