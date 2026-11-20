import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http } from 'viem';
import { AmmoraV4LaunchCurveClient, classifyAmmoraV4ExactInputFill, giwaSepoliaAutoRouteDeployment, parseAmmoraV4MigratedReceipt, parseAmmoraV4SwapReceipt } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const buyer = '0x5555555555555555555555555555555555555555';
const launch = JSON.parse(readFileSync(new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url)));
const curveAddress = launch.tokenLaunch.event.curve;
const token = launch.tokenLaunch.event.token;
const weth = '0x4200000000000000000000000000000000000006';
const deployment = giwaSepoliaAutoRouteDeployment.contracts.launch;
const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [local] } } });
const client = createPublicClient({ chain, cacheTime: 0, transport: http(local, { timeout: 30_000, retryCount: 0 }) });
const curve = new AmmoraV4LaunchCurveClient(client, curveAddress, { launchFactory: deployment.factory, feePolicy: deployment.feePolicy });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const rpc = async (method, params = []) => { const r = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', curve: curveAddress, token, buyer, stages: {} };
const snapshot = async () => { const block = await client.getBlockNumber(); return { block, curve: await curve.getStateAtBlock(block), progress: await curve.getMigrationProgressAtBlock(block), buyerWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: block }), buyerBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [buyer], blockNumber: block }), curveWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [curveAddress], blockNumber: block }), curveBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [curveAddress], blockNumber: block }), allowanceWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'allowance', args: [buyer, curveAddress], blockNumber: block }) }; };
const send = async transaction => { const hash = await rpc('eth_sendTransaction', [{ from: buyer, to: transaction.to, data: transaction.data, value: `0x${(transaction.value ?? 0n).toString(16)}` }]); const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }); if (receipt.status !== 'success') throw new Error(`Local transaction reverted ${hash}`); return { hash, receipt }; };
const buy = async (amount, allowPartialFill) => {
  const block = await client.getBlock();
  const plan = await curve.planSwapExactInput({ includedAmountIn: amount, baseForQuote: false, allowPartialFill, slippageBps: 100, recipient: buyer, deadline: block.timestamp + 3600n });
  if (plan.approvalRequirement.spender.toLowerCase() !== curveAddress.toLowerCase() || plan.approvalRequirement.token.toLowerCase() !== weth.toLowerCase() || plan.approvalRequirement.amount !== amount) throw new Error('Buy approval mismatch');
  const approval = await send({ to: weth, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curveAddress, amount] }), value: 0n });
  const transaction = await send(plan.transaction);
  const event = parseAmmoraV4SwapReceipt(transaction.receipt, curveAddress, { trader: buyer, recipient: buyer, baseForQuote: false, requestedAmountIn: amount });
  return { plan, approval: { hash: approval.hash, gasUsed: approval.receipt.gasUsed }, transaction: { hash: transaction.hash, receipt: transaction.receipt }, event, state: await snapshot() };
};
try {
  const metadata = await rpc('hardhat_metadata');
  if (metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== 41715770) throw new Error('Wrong local fork');
  report.before = await snapshot();
  if (report.before.curve.status !== 1 || report.before.block !== 41715777n) throw new Error(`Unexpected starting state ${report.before.block}`);
  report.preTerminal = await buy(3_000_000_000_000_000n, false);
  report.nearTerminal = await buy(1_000_000_000_000_000n, false);
  report.stages.preTerminal = 'PASS';
  const branch = await rpc('evm_snapshot');
  report.branchSnapshot = branch;
  const head = await client.getBlockNumber();
  const overshootInput = 2_000_000_000_000_000n;
  const overshootQuote = await curve.quoteExactInputAtBlock(overshootInput, false, head);
  report.overshootQuote = { ...overshootQuote, classification: classifyAmmoraV4ExactInputFill(overshootQuote, false) };
  if (report.overshootQuote.classification.kind !== 'graduation-boundary' || overshootQuote.amountLeft <= 0n) throw new Error('No terminal overshoot');
  const exact = overshootQuote.amountIn;
  const exactQuote = await curve.quoteExactInputAtBlock(exact, false, head);
  report.exactQuote = { ...exactQuote, classification: classifyAmmoraV4ExactInputFill(exactQuote, false) };
  if (exactQuote.amountLeft !== 0n) throw new Error('Exact terminal input still partial');
  try { report.exactBoundary = await buy(exact, false); report.stages.exactBoundary = report.exactBoundary.state.progress.ready ? 'PASS' : 'FAIL'; }
  catch (error) { report.exactBoundary = { error: String(error) }; report.stages.exactBoundary = 'FAIL'; }
  const restored = await rpc('evm_revert', [branch]);
  if (restored !== true) throw new Error('Fork branch revert failed');
  report.afterRevert = await snapshot();
  if (report.afterRevert.block !== head || report.afterRevert.curve.quoteReserve !== report.nearTerminal.state.curve.quoteReserve) throw new Error('Fork branch state mismatch');
  report.overshoot = await buy(overshootInput, true);
  report.stages.overshoot = report.overshoot.state.progress.ready ? 'PASS' : 'FAIL';
  if (report.overshoot.event.amountLeft !== overshootQuote.amountLeft || report.overshoot.state.buyerWeth !== report.afterRevert.buyerWeth - overshootQuote.amountIn) throw new Error('Refund reconciliation failed');
  report.stages.refund = 'PASS';
  try { await curve.planSwapExactInput({ includedAmountIn: 1n, baseForQuote: false, allowPartialFill: false, slippageBps: 100, recipient: buyer, deadline: (await client.getBlock()).timestamp + 3600n }); report.stages.repeatTerminalBuy = 'FAIL'; }
  catch (error) { report.repeatTerminalBuyError = String(error); report.stages.repeatTerminalBuy = 'PASS'; }
  const migrationPlan = await curve.planMigrateAtBlock(report.overshoot.state.block);
  report.migrationPlan = migrationPlan;
  try {
    const migrated = await send(migrationPlan.transaction);
    report.migration = { transaction: migrated, event: parseAmmoraV4MigratedReceipt(migrated.receipt, curveAddress), state: await snapshot() };
    report.stages.migration = report.migration.state.progress.migrated ? 'PASS' : 'FAIL';
  } catch (error) { report.migrationError = String(error); report.stages.migration = 'FAIL'; }
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { const path = `fixtures/onchain/local-fork-terminal-${new Date().toISOString().replaceAll(':', '-')}.json`; writeFileSync(path, json(report) + '\n'); console.log(path); }
