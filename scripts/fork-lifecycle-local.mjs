import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256 } from 'viem';
import {
  getAmmoraV4ConfigAtBlock, giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4ConfigCreatedReceipt, parseAmmoraV4LaunchCreatedReceipt,
  AmmoraV4LaunchCurveClient,
} from '@ammora-protocol/sdk';

// Hard stop: local Hardhat only. The upstream bridge rejects write methods.
const local = 'http://127.0.0.1:8545';
const expectedForkBlock = 41715770;
const expectedForkHash = '0xeea8192215013ad2dfd0f9564f43dbf448c0eab5f9150151a83da21fee042a9a';
const owner = '0x4444444444444444444444444444444444444444';
const fixture = JSON.parse(readFileSync(new URL('../fixtures/onchain/graduation-preview-2026-11-19T04-01-54.932Z.json', import.meta.url)));
const candidate = fixture.variants.find(v => v.name === 'A');
const deployment = giwaSepoliaAutoRouteDeployment.contracts.launch;
const expectedRuntime = {
  [deployment.factory.toLowerCase()]: '0xf4bdf481252fb37bae95df148ba66e788ff59f22205d4e9c2f4df2c55c4fa173',
  [deployment.configRegistry.toLowerCase()]: '0xd74516d51f2d02dba03d09828ecfa1bcbca363b295765cf57f8c07401826b257',
};
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const rpc = async (method, params = []) => {
  const response = await fetch(local, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
};
const client = createPublicClient({ transport: http(local, { timeout: 30_000, retryCount: 0 }) });
const evidence = { utc: new Date().toISOString(), label: 'LOCAL_FORK_ONLY', upstream: 'GIWA Sepolia read-only RPC bridge', forkBlock: expectedForkBlock, forkHash: expectedForkHash, sdk: '0.3.9', stages: {} };
const save = () => {
  const file = `fixtures/onchain/local-fork-lifecycle-${new Date().toISOString().replaceAll(':', '-')}.json`;
  writeFileSync(file, json(evidence) + '\n');
  console.log(file);
};
try {
  const metadata = await rpc('hardhat_metadata');
  const chainId = await rpc('eth_chainId');
  if (chainId !== '0x164ce' || metadata.forkedNetwork?.forkBlockNumber !== expectedForkBlock || metadata.forkedNetwork.forkBlockHash !== expectedForkHash) throw new Error('Wrong local fork identity');
  evidence.forkMetadata = { clientVersion: metadata.clientVersion, chainId: metadata.chainId, forkedNetwork: metadata.forkedNetwork };
  evidence.runtime = {};
  for (const address of [deployment.factory, deployment.configRegistry]) {
    const code = await client.getCode({ address });
    const hash = keccak256(code);
    evidence.runtime[address] = hash;
    if (hash !== expectedRuntime[address.toLowerCase()]) throw new Error(`Runtime mismatch ${address}`);
  }
  evidence.stages.fork = 'PASS';

  await rpc('hardhat_impersonateAccount', [owner]);
  await rpc('hardhat_setBalance', [owner, '0x56bc75e2d63100000']);
  const beforeId = await client.readContract({ address: deployment.configRegistry, abi: (await import('@ammora-protocol/sdk')).ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
  evidence.beforeId = beforeId;
  if (beforeId !== 63n || candidate.configCreation.to.toLowerCase() !== deployment.configRegistry.toLowerCase() || candidate.configCreation.value !== '0') throw new Error('Config identity drift');
  const configHash = await rpc('eth_sendTransaction', [{ from: owner, to: deployment.configRegistry, data: candidate.configCreation.calldata, value: '0x0' }]);
  const configReceipt = await client.waitForTransactionReceipt({ hash: configHash, timeout: 30_000 });
  evidence.configCreation = { transactionHash: configHash, receipt: configReceipt };
  if (configReceipt.status !== 'success') throw new Error('Local Config creation reverted');
  const configEvent = parseAmmoraV4ConfigCreatedReceipt(configReceipt, deployment.configRegistry);
  evidence.configCreation.event = configEvent;
  const created = await getAmmoraV4ConfigAtBlock(client, deployment.configRegistry, configEvent.configId, configReceipt.blockNumber);
  evidence.configCreation.readback = { configId: created.configId, configHash: created.configHash, owner: created.identity.owner, partnerRecipient: created.config.partnerRecipient, liquidityPartner: created.config.liquidityDistribution.partner, leftoverReceiver: created.config.leftoverReceiver, totalSupply: created.config.totalSupply, migrationQuoteThreshold: created.config.migrationQuoteThreshold, migrationBaseThreshold: created.config.migrationBaseThreshold };
  if (configEvent.configId !== beforeId || created.configHash !== candidate.simulation.simulatedConfigHash || created.identity.owner.toLowerCase() !== owner.toLowerCase() || created.config.totalSupply !== BigInt(candidate.config.totalSupply)) throw new Error('Config event/readback mismatch');
  evidence.stages.configCreation = 'PASS';

  if (candidate.tokenLaunch.to.toLowerCase() !== deployment.factory.toLowerCase() || candidate.tokenLaunch.value !== '0') throw new Error('Launch target/value drift');
  const launchHash = await rpc('eth_sendTransaction', [{ from: owner, to: deployment.factory, data: candidate.tokenLaunch.calldata, value: '0x0' }]);
  const launchReceipt = await client.waitForTransactionReceipt({ hash: launchHash, timeout: 30_000 });
  evidence.tokenLaunch = { transactionHash: launchHash, receipt: launchReceipt };
  if (launchReceipt.status !== 'success') throw new Error('Local token launch reverted');
  const launchEvent = parseAmmoraV4LaunchCreatedReceipt(launchReceipt, deployment.factory);
  evidence.tokenLaunch.event = launchEvent;
  if (launchEvent.creator.toLowerCase() !== owner.toLowerCase() || launchEvent.configId !== configEvent.configId || launchEvent.metadataURI !== candidate.tokenLaunch.decodedArgs[2]) throw new Error('Launch event mismatch');
  const curve = new AmmoraV4LaunchCurveClient(client, launchEvent.curve, { launchFactory: deployment.factory, feePolicy: deployment.feePolicy });
  evidence.tokenLaunch.curveState = await curve.getStateAtBlock(launchReceipt.blockNumber);
  evidence.stages.tokenLaunch = 'PASS';
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
} finally { save(); }
