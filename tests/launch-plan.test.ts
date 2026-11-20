import { expect, test } from 'vitest';
import { encodeAbiParameters, encodeFunctionData } from 'viem';
import { segmentedALCLaunchFactoryV3Abi } from '@ammora-protocol/sdk';
import { assertLaunchPlan } from '../src/lib/launch-plan';

const factory = '0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA';
const helper = '0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451';
const creator = '0x000000000000000000000000000000000000dEaD';
const common = { factory, name: 'Review', symbol: 'REV', uri: 'https://fairlaunch.example/api/metadata/test', configId: 6n, decimals: 9, fee: 100n } as const;
const args = [common.name, common.symbol, common.uri, common.uri, common.configId, common.decimals] as const;

test('rejects modified launch selector, metadata and fee', () => {
  const plan = { to: factory, data: encodeFunctionData({ abi: segmentedALCLaunchFactoryV3Abi, functionName: 'createLaunchWithTokenConfig', args }), value: 100n } as const;
  expect(() => assertLaunchPlan(plan, common)).not.toThrow();
  expect(() => assertLaunchPlan(plan, { ...common, uri: common.uri + '/other' })).toThrow('calldata');
  expect(() => assertLaunchPlan({ ...plan, value: 101n }, common)).toThrow('fee');
});

test('first-buy calldata must keep the approved amount, minimum and recipient', () => {
  const amount = 1000n; const minOut = 500n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
  const callback = encodeAbiParameters([{ type: 'tuple[]', components: [
    { name: 'includedQuoteAmount', type: 'uint256' }, { name: 'minimumBaseAmountOut', type: 'uint256' },
    { name: 'allowPartialFill', type: 'bool' }, { name: 'recipient', type: 'address' }, { name: 'referrer', type: 'address' },
  ] }, { type: 'uint256' }], [[{ includedQuoteAmount: amount, minimumBaseAmountOut: minOut, allowPartialFill: false, recipient: creator, referrer: '0x0000000000000000000000000000000000000000' }], deadline]);
  const plan = { to: factory, data: encodeFunctionData({ abi: segmentedALCLaunchFactoryV3Abi, functionName: 'createLaunchAndCall', args: [...args, helper, callback] }), value: 100n } as const;
  const expected = { ...common, firstBuy: { helper, amount, minOut, recipient: creator, deadline } } as const;
  expect(() => assertLaunchPlan(plan, expected)).not.toThrow();
  expect(() => assertLaunchPlan(plan, { ...common, firstBuy: { ...expected.firstBuy, amount: amount + 1n } })).toThrow('First-buy calldata');
  expect(() => assertLaunchPlan(plan, { ...common, firstBuy: { ...expected.firstBuy, deadline: deadline + 1n } })).toThrow('First-buy calldata');
  const foreignReferrer = encodeAbiParameters([{ type: 'tuple[]', components: [
    { name: 'includedQuoteAmount', type: 'uint256' }, { name: 'minimumBaseAmountOut', type: 'uint256' },
    { name: 'allowPartialFill', type: 'bool' }, { name: 'recipient', type: 'address' }, { name: 'referrer', type: 'address' },
  ] }, { type: 'uint256' }], [[{ includedQuoteAmount: amount, minimumBaseAmountOut: minOut, allowPartialFill: false, recipient: creator, referrer: creator }], deadline]);
  const altered = { ...plan, data: encodeFunctionData({ abi: segmentedALCLaunchFactoryV3Abi, functionName: 'createLaunchAndCall', args: [...args, helper, foreignReferrer] }) };
  expect(() => assertLaunchPlan(altered, expected)).toThrow('First-buy calldata');
});
