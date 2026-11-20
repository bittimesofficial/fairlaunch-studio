import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http } from 'viem';
import { AmmoraV4LaunchCurveClient, giwaSepoliaAutoRouteDeployment, parseAmmoraV4SwapReceipt } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const buyer = '0x5555555555555555555555555555555555555555';
const launch = JSON.parse(readFileSync(new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url)));
const curveAddress = launch.tokenLaunch.event.curve;
const token = launch.tokenLaunch.event.token;
const weth = '0x4200000000000000000000000000000000000006';
const deployment = giwaSepoliaAutoRouteDeployment.contracts.launch;
const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [local] } } });
const client = createPublicClient({ chain, transport: http(local, { timeout: 30_000, retryCount: 0 }) });
const curve = new AmmoraV4LaunchCurveClient(client, curveAddress, { launchFactory: deployment.factory, feePolicy: deployment.feePolicy });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const rpc = async (method, params = []) => { const r = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', curve: curveAddress, token, buyer, stages: {} };
const snapshot = async () => ({ block: await client.getBlockNumber(), curve: await curve.getState(), buyerWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] }), buyerBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [buyer] }), curveWeth: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [curveAddress] }), curveBase: await client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [curveAddress] }) });
const send = async transaction => { const hash = await rpc('eth_sendTransaction', [{ from: buyer, to: transaction.to, data: transaction.data, value: `0x${(transaction.value ?? 0n).toString(16)}` }]); const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 }); if (receipt.status !== 'success') throw new Error(`Local transaction reverted ${hash}`); return { hash, receipt }; };
const approveExact = async (tokenAddress, spender, amount) => {
  if (spender.toLowerCase() !== curveAddress.toLowerCase()) throw new Error(`Unexpected spender ${spender}`);
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] });
  return send({ to: tokenAddress, data, value: 0n });
};
try {
  const metadata = await rpc('hardhat_metadata');
  if (metadata.forkedNetwork?.forkBlockNumber !== 41715770 || metadata.chainId !== 91342) throw new Error('Wrong fork');
  report.before = await snapshot();
  await rpc('hardhat_impersonateAccount', [buyer]);
  await rpc('hardhat_setBalance', [buyer, '0xde0b6b3a7640000']);
  const depositData = encodeFunctionData({ abi: [{ type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] }], functionName: 'deposit' });
  report.deposit = await send({ to: weth, data: depositData, value: 20_000_000_000_000_000n });
  const block = await client.getBlock();
  const deadline = block.timestamp + 3600n;
  const buyPlan = await curve.planSwapExactInput({ includedAmountIn: 1_000_000_000_000_000n, baseForQuote: false, allowPartialFill: false, slippageBps: 100, recipient: buyer, deadline });
  report.buyPlan = buyPlan;
  const buyApproval = buyPlan.approvalRequirement;
  report.buyApproval = await approveExact(buyApproval.token, buyApproval.spender, buyApproval.amount);
  report.buy = await send(buyPlan.transaction);
  report.buy.event = parseAmmoraV4SwapReceipt(report.buy.receipt, curveAddress, { trader: buyer, recipient: buyer, baseForQuote: false, requestedAmountIn: 1_000_000_000_000_000n });
  report.afterBuy = await snapshot();
  report.stages.buy = 'PASS';

  const saleRaw = report.afterBuy.buyerBase / 10n;
  if (saleRaw <= 0n) throw new Error('No base to sell');
  const sellPlan = await curve.planSwapExactInput({ includedAmountIn: saleRaw, baseForQuote: true, allowPartialFill: false, slippageBps: 100, recipient: buyer, deadline });
  report.sellPlan = sellPlan;
  const sellApproval = sellPlan.approvalRequirement;
  report.sellApproval = await approveExact(sellApproval.token, sellApproval.spender, sellApproval.amount);
  report.sell = await send(sellPlan.transaction);
  report.sell.event = parseAmmoraV4SwapReceipt(report.sell.receipt, curveAddress, { trader: buyer, recipient: buyer, baseForQuote: true, requestedAmountIn: saleRaw });
  report.afterSell = await snapshot();
  report.stages.sell = 'PASS';
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { const path = `fixtures/onchain/local-fork-curve-${new Date().toISOString().replaceAll(':', '-')}.json`; writeFileSync(path, json(report) + '\n'); console.log(path); }
