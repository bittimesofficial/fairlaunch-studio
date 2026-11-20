import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http } from 'viem';
import { AmmoraSwapClient, giwaSepoliaAutoRouteDeploymentCatalog, giwaSepoliaAutoRoutePoolProfiles } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const buyer = '0x5555555555555555555555555555555555555555';
const launch = JSON.parse(readFileSync(process.argv[2] ?? new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url)));
const migration = JSON.parse(readFileSync(process.argv[3] ?? new URL('../fixtures/onchain/local-fork-terminal-2026-11-19T04-20-04.169Z.json', import.meta.url)));
const pool = migration.migration.event.canonicalPool;
const token = launch.tokenLaunch.event.token;
const weth = '0x4200000000000000000000000000000000000006';
const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [local] } } });
const client = createPublicClient({ chain, cacheTime: 0, transport: http(local, { timeout: 30_000, retryCount: 0 }) });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const rpc = async (method, params = []) => { const r = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', pool, buyer, stages: {} };
const balances = async () => { const block = await client.getBlockNumber(); return { block, buyerWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: block }), buyerBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: block }), poolWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: block }), poolBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [pool], blockNumber: block }) }; };
const send = async transaction => { const hash = await rpc('eth_sendTransaction', [{ from: buyer, to: transaction.to, data: transaction.data, value: `0x${(transaction.value ?? 0n).toString(16)}` }]); const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }); if (receipt.status !== 'success') throw new Error(`Local transaction reverted ${hash}`); return { hash, receipt }; };
const swap = async (sdk, tokenIn, amountIn) => {
  const prepared = await sdk.prepareExactIn({ model: 'concentrated', pool, tokenIn, amountIn, payer: buyer, recipient: buyer, slippageBps: 100, quoteBlockNumber: await client.getBlockNumber() });
  if (prepared.isExpired() || prepared.quote.remainderAmountIn !== 0n || prepared.transaction.to.toLowerCase() !== pool.toLowerCase() || prepared.approvalRequirements.length !== 1) throw new Error('Unsafe pool plan');
  const requirement = prepared.approvalRequirements[0];
  if (requirement.token.toLowerCase() !== tokenIn.toLowerCase() || requirement.spender.toLowerCase() !== pool.toLowerCase() || requirement.amount !== amountIn) throw new Error('Wrong pool spender or approval amount');
  const approval = await send({ to: tokenIn, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [pool, amountIn] }), value: 0n });
  const transaction = await send(prepared.transaction);
  return { quote: prepared.quote, approval: { hash: approval.hash, gasUsed: approval.receipt.gasUsed }, transaction, balances: await balances() };
};
try {
  const metadata = await rpc('hardhat_metadata');
  if (metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== 41715770) throw new Error('Wrong local fork');
  report.before = await balances();
  const sdk = await AmmoraSwapClient.create(client, { deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
  report.buy = await swap(sdk, weth, 10_000_000_000_000n);
  if (report.buy.balances.buyerBase - report.before.buyerBase < report.buy.quote.minimumAmountOut) throw new Error('Pool buy output below minimum');
  report.stages.buy = 'PASS';
  report.sell = await swap(sdk, token, 1_000_000_000_000n);
  if (report.sell.balances.buyerWeth - report.buy.balances.buyerWeth < report.sell.quote.minimumAmountOut) throw new Error('Pool sell output below minimum');
  report.stages.sell = 'PASS';
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { const path = `fixtures/onchain/local-fork-pool-trade-${new Date().toISOString().replaceAll(':', '-')}.json`; writeFileSync(path, json(report) + '\n'); console.log(path); }
