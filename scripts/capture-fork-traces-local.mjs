import { readFileSync, writeFileSync } from 'node:fs';

const local = 'http://127.0.0.1:8545';
const load = name => JSON.parse(readFileSync(new URL(`../fixtures/onchain/${name}`, import.meta.url)));
const launch = load('local-fork-lifecycle-2026-11-19T04-16-14.914Z.json');
const curve = load('local-fork-curve-2026-11-19T04-17-29.583Z.json');
const terminal = load('local-fork-terminal-2026-11-19T04-20-04.169Z.json');
const pool = load('local-fork-pool-trade-2026-11-19T04-24-41.907Z.json');
const txs = {
  configCreation: launch.configCreation.transactionHash,
  tokenLaunch: launch.tokenLaunch.transactionHash,
  curveBuy: curve.buy.hash,
  curveSell: curve.sell.hash,
  nearTerminal: terminal.nearTerminal.transaction.hash,
  overshoot: terminal.overshoot.transaction.hash,
  migration: terminal.migration.transaction.hash,
  poolBuy: pool.buy.transaction.hash,
  poolSell: pool.sell.transaction.hash,
};
const rpc = async (method, params = []) => { const r = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); const b = await r.json(); if (b.error) throw new Error(`${method}: ${b.error.message}`); return b.result; };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', forkBlock: 41715770, traces: {} };
try {
  const metadata = await rpc('hardhat_metadata');
  if (metadata.chainId !== 91342 || metadata.forkedNetwork?.forkBlockNumber !== 41715770) throw new Error('Wrong local fork');
  for (const [stage, hash] of Object.entries(txs)) {
    const trace = await rpc('debug_traceTransaction', [hash, { tracer: 'callTracer' }]);
    report.traces[stage] = { transactionHash: hash, trace };
    if (trace.error) throw new Error(`${stage} trace has error: ${trace.error}`);
  }
} catch (error) { report.error = String(error); process.exitCode = 1; }
const path = `fixtures/onchain/local-fork-call-traces-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
console.log(path);
