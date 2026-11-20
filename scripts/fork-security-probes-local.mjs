import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http } from 'viem';
import { ammoraLaunchConfigRegistryV4Abi, parseAmmoraV4ConfigCreatedReceipt } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const buyer = '0x5555555555555555555555555555555555555555';
const preview = JSON.parse(readFileSync(new URL('../fixtures/onchain/graduation-preview-2026-11-19T04-01-54.932Z.json', import.meta.url)));
const launch = JSON.parse(readFileSync(process.argv[2] ?? new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url)));
const terminal = JSON.parse(readFileSync(process.argv[3] ?? new URL('../fixtures/onchain/local-fork-terminal-2026-11-19T04-20-04.169Z.json', import.meta.url)));
const curve = launch.tokenLaunch.event.curve;
const weth = '0x4200000000000000000000000000000000000006';
const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [local] } } });
const client = createPublicClient({ chain, cacheTime: 0, transport: http(local, { timeout: 20_000, retryCount: 0 }) });
const rpc = async (method, params = []) => { const r = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', stages: {} };
try {
  const metadata = await rpc('hardhat_metadata');
  if (metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== 41715770) throw new Error('Wrong local fork');
  const nextBefore = await client.readContract({ address: preview.registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
  if (nextBefore !== 64n) throw new Error('Duplicate probe requires one prior local Config A creation');
  const result = await client.call({ account: preview.addresses.configOwner, to: preview.registry, data: preview.variants[0].configCreation.calldata });
  const duplicateHash = await rpc('eth_sendTransaction', [{ from: preview.addresses.configOwner, to: preview.registry, data: preview.variants[0].configCreation.calldata, value: '0x0' }]);
  const duplicateReceipt = await client.waitForTransactionReceipt({ hash: duplicateHash, timeout: 30_000 });
  const duplicateEvent = parseAmmoraV4ConfigCreatedReceipt(duplicateReceipt, preview.registry);
  const nextAfter = await client.readContract({ address: preview.registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId', blockNumber: duplicateReceipt.blockNumber });
  if (duplicateReceipt.status !== 'success' || duplicateEvent.configId !== 64n || duplicateEvent.configHash.toLowerCase() !== launch.configCreation.event.configHash.toLowerCase() || nextAfter !== 65n) throw new Error('Duplicate Registry transaction readback mismatch');
  report.duplicateConfig = { acceptedByEthCall: true, returnData: result.data, nextBefore, transactionHash: duplicateHash, receipt: duplicateReceipt, event: duplicateEvent, nextAfter };
  report.stages.duplicateRegistryGuard = 'NOT_APPLICABLE';
  report.stages.duplicateCreationObserved = 'PASS';
  try { await client.call({ account: buyer, to: curve, data: terminal.nearTerminal.plan.transaction.data }); report.stages.staleCurveCalldata = 'FAIL'; }
  catch (error) { report.staleCurveError = String(error); report.stages.staleCurveCalldata = 'PASS'; }
  try { await client.call({ account: buyer, to: curve, data: terminal.migrationPlan.transaction.data }); report.stages.repeatMigrate = 'FAIL'; }
  catch (error) { report.repeatMigrateError = String(error); report.stages.repeatMigrate = 'PASS'; }
  report.allowanceBeforeCleanup = await client.readContract({ address: weth, abi: erc20Abi, functionName: 'allowance', args: [buyer, curve] });
  if (report.allowanceBeforeCleanup <= 0n) throw new Error('Expected partial-fill residual allowance absent');
  const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [curve, 0n] });
  const hash = await rpc('eth_sendTransaction', [{ from: buyer, to: weth, data, value: '0x0' }]);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 30_000 });
  report.cleanup = { hash, receipt };
  report.allowanceAfterCleanup = await client.readContract({ address: weth, abi: erc20Abi, functionName: 'allowance', args: [buyer, curve], blockNumber: receipt.blockNumber });
  if (receipt.status !== 'success' || report.allowanceAfterCleanup !== 0n) throw new Error('Allowance cleanup failed');
  report.stages.allowanceCleanup = 'PASS';
} catch (error) { report.error = String(error); process.exitCode = 1; }
const path = `fixtures/onchain/local-fork-security-probes-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(path, JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
console.log(path);
if (Object.values(report.stages).some(stage => stage !== 'PASS' && stage !== 'NOT_APPLICABLE')) process.exitCode = 1;
