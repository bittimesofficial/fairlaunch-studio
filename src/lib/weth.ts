import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem';

export const giwaWethAddress = '0x4200000000000000000000000000000000000006' as Address;
export const wethAbi = parseAbi(['function name() view returns (string)', 'function decimals() view returns (uint8)', 'function deposit() payable', 'function withdraw(uint256)']);

export function wethPlan(kind: 'Wrap' | 'Unwrap', amount: bigint, ethBalance: bigint, wethBalance: bigint): { to: Address; data: Hex; value: bigint } {
  if (amount <= 0n) throw new Error('Enter a positive amount');
  if (kind === 'Wrap' && ethBalance <= amount + 100_000_000_000_000n) throw new Error('Leave at least 0.0001 ETH for gas');
  if (kind === 'Unwrap' && wethBalance < amount) throw new Error('Insufficient WETH to unwrap');
  return kind === 'Wrap'
    ? { to: giwaWethAddress, data: encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }), value: amount }
    : { to: giwaWethAddress, data: encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [amount] }), value: 0n };
}
