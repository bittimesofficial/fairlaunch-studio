import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, defineChain, erc20Abi, erc721Abi, http, keccak256 } from 'viem';
import { ARLClient, AmmoraSwapClient, ammConcentratedPositionManagerV3Abi, createAmmoraDeploymentSource, decodeAmmoraConcentratedPositionManagerEvents, giwaSepoliaAutoRouteDeployment, giwaSepoliaAutoRouteDeploymentCatalog, giwaSepoliaAutoRoutePoolProfiles, resolveAmmoraV4ConcentratedMigrationPositionsReceipt } from '@ammora-protocol/sdk';

const local = 'http://127.0.0.1:8545';
const migration = JSON.parse(readFileSync(process.argv[2] ?? new URL('../fixtures/onchain/local-fork-terminal-2026-11-19T04-20-04.169Z.json', import.meta.url)));
const launch = JSON.parse(readFileSync(process.argv[3] ?? new URL('../fixtures/onchain/local-fork-lifecycle-2026-11-19T04-16-14.914Z.json', import.meta.url)));
const preview = JSON.parse(readFileSync(new URL('../fixtures/onchain/graduation-preview-2026-11-19T04-01-54.932Z.json', import.meta.url)));
const partnerBps = Number(preview.variants[0].config.liquidityDistribution.partnerUnlockedBps) + Number(preview.variants[0].config.liquidityDistribution.partnerPermanentLockedBps) + Number(preview.variants[0].config.liquidityDistribution.partnerVesting.allocationBps);
const deployment = giwaSepoliaAutoRouteDeployment.contracts.launch;
const chain = defineChain({ id: 91342, name: 'GIWA local fork', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [local] } } });
const client = createPublicClient({ chain, cacheTime: 0, transport: http(local, { timeout: 30_000, retryCount: 0 }) });
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const pool = migration.migration.event.canonicalPool;
const token = launch.tokenLaunch.event.token;
const weth = '0x4200000000000000000000000000000000000006';
const before = 41715783n, after = 41715784n;
const addresses = { curve: launch.tokenLaunch.event.curve, pool, adapter: deployment.graduationAdapter, positionManager: deployment.concentratedPositionManager, creator: launch.tokenLaunch.event.creator, partner: '0x2222222222222222222222222222222222222222', feeRecipient: '0x1111111111111111111111111111111111111111', leftoverReceiver: '0x3333333333333333333333333333333333333333', protocolRecipient: migration.overshoot.state.curve.protocolRecipient, feeVault: migration.overshoot.state.curve.feeVault };
const report = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', beforeBlock: before, afterBlock: after, addresses, stages: {} };
try {
  const receipt = await client.getTransactionReceipt({ hash: migration.migration.transaction.hash });
  report.migrationReceipt = receipt;
  report.positionEvents = decodeAmmoraConcentratedPositionManagerEvents({ chainId: 91342, receipt, positionManagers: [addresses.positionManager] });
  if (partnerBps > 0) {
    try { report.positions = resolveAmmoraV4ConcentratedMigrationPositionsReceipt({ chainId: 91342, receipt, expectedTransactionHash: receipt.transactionHash, curve: addresses.curve, positionManager: addresses.positionManager, canonicalPool: pool, creator: addresses.creator, partner: addresses.partner }); report.stages.lpProvenance = 'PASS'; }
    catch (error) { report.positionsError = String(error); report.stages.lpProvenance = 'BLOCKED'; }
  } else {
    report.partnerAllocation = { configuredBps: 0, status: 'NOT_APPLICABLE', reason: 'Config A assigns zero LP liquidity to Partner' };
    if (report.positionEvents.some(event => event.name === 'Transfer' && event.args.to?.toLowerCase() === addresses.partner.toLowerCase())) throw new Error('Unexpected Partner position transfer');
    report.stages.lpProvenance = 'PASS';
  }
  const wrapped = report.positionEvents.filter(event => event.name === 'PositionWrapped');
  const locks = report.positionEvents.filter(event => event.name === 'PositionPermanentlyLocked');
  const creatorTransfers = report.positionEvents.filter(event => event.name === 'Transfer' && event.args.to?.toLowerCase() === addresses.creator.toLowerCase());
  const migratedLiquidity = BigInt(migration.migration.event.liquidity);
  const lockedLiquidity = locks.reduce((sum, event) => sum + BigInt(event.args.liquidity), 0n);
  const wrappedLiquidity = wrapped.reduce((sum, event) => sum + BigInt(event.args.liquidity), 0n);
  report.lpAllocation = { wrappedLiquidity, migratedLiquidity, lockedLiquidity, creatorTransfers: creatorTransfers.map(event => event.args.tokenId), tokenOwners: {}, positionState: {} };
  for (const event of wrapped) {
    report.lpAllocation.tokenOwners[event.args.tokenId] = await client.readContract({ address: addresses.positionManager, abi: erc721Abi, functionName: 'ownerOf', args: [BigInt(event.args.tokenId)], blockNumber: after });
    report.lpAllocation.positionState[event.args.tokenId] = await client.readContract({ address: addresses.positionManager, abi: ammConcentratedPositionManagerV3Abi, functionName: 'getPosition', args: [BigInt(event.args.tokenId)], blockNumber: after });
  }
  const stateLiquidity = Object.values(report.lpAllocation.positionState).reduce((sum, position) => sum + position.unlockedLiquidity + position.vestedLiquidity + position.permanentLockedLiquidity, 0n);
  const stateLocked = Object.values(report.lpAllocation.positionState).reduce((sum, position) => sum + position.permanentLockedLiquidity, 0n);
  if (wrappedLiquidity !== migratedLiquidity || lockedLiquidity * 10000n !== migratedLiquidity * 1000n || stateLiquidity !== migratedLiquidity || stateLocked !== lockedLiquidity || wrapped.length !== creatorTransfers.length || Object.values(report.lpAllocation.tokenOwners).some(owner => owner.toLowerCase() !== addresses.creator.toLowerCase())) throw new Error('LP allocation receipt/readback mismatch');
  report.stages.lpAllocation = 'PASS';
  report.balances = {};
  for (const [role, address] of Object.entries(addresses)) {
    report.balances[role] = {};
    for (const [asset, assetAddress] of [['base', token], ['weth', weth]]) {
      const b = await client.readContract({ address: assetAddress, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber: before });
      const a = await client.readContract({ address: assetAddress, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber: after });
      report.balances[role][asset] = { before: b, after: a, delta: a - b };
    }
  }
  report.poolRuntime = { bytes: ((await client.getCode({ address: pool, blockNumber: after })).length - 2) / 2, hash: keccak256(await client.getCode({ address: pool, blockNumber: after })) };
  report.stages.balances = 'PASS';
  const b = report.balances;
  if (b.curve.base.delta + b.pool.base.delta + b.feeVault.base.delta !== 0n || b.curve.weth.delta + b.pool.weth.delta + b.feeVault.weth.delta !== 0n) throw new Error('Migration balance conservation failed');
  report.stages.reserveReconciliation = 'PASS';
  const arl = new ARLClient(client, pool, 'concentrated', deployment.concentratedFactory, deployment.concentratedPositionManager, { deploymentSource: createAmmoraDeploymentSource([giwaSepoliaAutoRouteDeployment]), factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
  report.arl = { provenance: await arl.getPoolProvenance(), quote: await arl.quoteExactInput(weth, 10000000000000n) };
  const profile = giwaSepoliaAutoRoutePoolProfiles.find(item => item.chainId === 91342 && item.kind === 'concentrated');
  if (!profile || profile.factory.toLowerCase() !== deployment.concentratedFactory.toLowerCase()) throw new Error('Official SDK pool profile mismatch');
  const poolFactory = await client.readContract({ address: pool, abi: [{ type: 'function', name: 'factory', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }], functionName: 'factory', blockNumber: after });
  const factoryRuntimeHash = keccak256(await client.getCode({ address: poolFactory, blockNumber: after }));
  if (poolFactory.toLowerCase() !== profile.factory.toLowerCase() || factoryRuntimeHash !== profile.factoryRuntimeCodeHash) throw new Error('Pool factory provenance/runtime mismatch');
  report.poolProvenance = { poolFactory, factoryRuntimeHash, sdkProfileRevision: profile.revision, sdkSourceCommit: profile.sourceCommit };
  report.stages.poolProvenance = 'PASS';
  const swap = await AmmoraSwapClient.create(client, { deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog, factoryProfiles: giwaSepoliaAutoRoutePoolProfiles });
  const prepared = await swap.prepareExactIn({ model: 'concentrated', pool, tokenIn: weth, amountIn: 10000000000000n, payer: addresses.creator, recipient: addresses.creator, slippageBps: 100, quoteBlockNumber: after });
  if (prepared.isExpired() || prepared.transaction.to.toLowerCase() !== pool.toLowerCase() || prepared.quote.minimumAmountOut <= 0n) throw new Error('Official SDK pool quote invalid');
  report.poolQuote = prepared.quote;
  report.stages.poolQuote = 'PASS';
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally { const path = `fixtures/onchain/local-fork-migration-audit-${new Date().toISOString().replaceAll(':', '-')}.json`; writeFileSync(path, json(report) + '\n'); console.log(path); if (Object.values(report.stages).some(stage => stage !== 'PASS')) process.exitCode = 1; }
