import { expect, test, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { Launch } from '../src/lib/catalog';

vi.mock('../src/lib/chain', async () => {
  const { giwaSepoliaAutoRouteDeployment } = await import('@ammora-protocol/sdk');
  const { createPublicClient, defineChain, http } = await import('viem');
  const rpc = process.env.LOCAL_FORK_RPC || 'http://127.0.0.1:8545';
  const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  return { deployment: giwaSepoliaAutoRouteDeployment, factory: giwaSepoliaAutoRouteDeployment.contracts.launch.factory, registry: giwaSepoliaAutoRouteDeployment.contracts.launch.configRegistry, publicClient: createPublicClient({ chain, cacheTime: 0, transport: http(rpc) }) };
});

test.skipIf(!process.env.LOCAL_FORK_RPC)('app V4 route plans and executes pool buy/sell on the pinned local fork', async () => {
  if (process.env.LOCAL_FORK_RPC !== 'http://127.0.0.1:8545') throw new Error('Local fork RPC only');
  const rpc = async (method: string, params: unknown[] = []) => {
    const response = await fetch(process.env.LOCAL_FORK_RPC!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const body = await response.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
  const metadata = await rpc('hardhat_metadata');
  if (metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== 41715770 || metadata.forkedNetwork?.forkBlockHash !== '0xeea8192215013ad2dfd0f9564f43dbf448c0eab5f9150151a83da21fee042a9a') throw new Error('Wrong fork identity');
  const launchEvidence = JSON.parse(readFileSync(process.env.LOCAL_FORK_LIFECYCLE_FILE ?? new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url), 'utf8'));
  const migratedEvidence = JSON.parse(readFileSync(process.env.LOCAL_FORK_TERMINAL_FILE ?? new URL('../fixtures/onchain/local-fork-terminal-2026-11-19T04-20-04.169Z.json', import.meta.url), 'utf8'));
  const { prepareTrade, v4Curve } = await import('../src/lib/trading');
  const { publicClient } = await import('../src/lib/chain');
  const launch: Launch = { token: launchEvidence.tokenLaunch.event.token, curve: launchEvidence.tokenLaunch.event.curve, creator: launchEvidence.tokenLaunch.event.creator, configId: '63', metadataURI: launchEvidence.tokenLaunch.event.metadataURI, hash: launchEvidence.tokenLaunch.transactionHash, block: launchEvidence.tokenLaunch.event.receiptBlockNumber };
  const block = await publicClient.getBlockNumber();
  const state = await v4Curve(launch.curve).getStateAtBlock(block);
  expect(state.status).toBe(3);
  const buyer = '0x5555555555555555555555555555555555555555';
  await expect(prepareTrade(launch, state, false, 'Buy', 10_000_000_000_000n, 100, buyer)).rejects.toThrow('Market stage changed');
  const evidence: { label: string; fork: unknown; pool: string; trades: unknown[] } = { label: 'LOCAL_FORK_ONLY', fork: metadata.forkedNetwork, pool: migratedEvidence.migration.event.canonicalPool, trades: [] };
  const send = async (to: string, data: string) => {
    const hash = await rpc('eth_sendTransaction', [{ from: buyer, to, data, value: '0x0' }]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
    expect(receipt.status).toBe('success');
    return receipt;
  };
  for (const [side, amount] of [['Buy', 10_000_000_000_000n], ['Sell', 1_000_000_000_000n]] as const) {
    const plan = await prepareTrade(launch, state, true, side, amount, 100, buyer);
    expect(plan.routeTarget.toLowerCase()).toBe(migratedEvidence.migration.event.canonicalPool.toLowerCase());
    expect(plan.approvalRequirement.spender.toLowerCase()).toBe(plan.routeTarget.toLowerCase());
    expect(plan.approvalRequirement.amount).toBe(amount);
    expect(plan.quote.minimumAmountOut).toBeGreaterThan(0n);
    const tokenIn = plan.approvalRequirement.token;
    const tokenOut = side === 'Buy' ? launch.token : '0x4200000000000000000000000000000000000006';
    const before = await publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] });
    const approval = await send(tokenIn, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [plan.routeTarget, amount] }));
    const receipt = await send(plan.transaction.to, plan.transaction.data);
    const after = await publicClient.readContract({ address: tokenOut, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: receipt.blockNumber });
    const remainingAllowance = await publicClient.readContract({ address: tokenIn, abi: erc20Abi, functionName: 'allowance', args: [buyer, plan.routeTarget], blockNumber: receipt.blockNumber });
    expect(after - before).toBeGreaterThanOrEqual(plan.quote.minimumAmountOut);
    expect(remainingAllowance).toBe(0n);
    evidence.trades.push({ side, amount, quote: plan.quote, spender: plan.approvalRequirement.spender, tokenIn, tokenOut, calldata: plan.transaction.data, approvalHash: approval.transactionHash, transactionHash: receipt.transactionHash, receipt, outputBefore: before, outputAfter: after, remainingAllowance });
  }
  writeFileSync(`fixtures/onchain/local-fork-app-route-${new Date().toISOString().replaceAll(':', '-')}.json`, JSON.stringify(evidence, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2) + '\n');
});
