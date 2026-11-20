import { mkdir, writeFile } from 'node:fs/promises';
import { getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId, giwaSepoliaAutoRouteDeployment, ammoraLaunchConfigRegistryV4Abi, segmentedALCConfigRegistryV3Abi, ammoraLaunchFactoryV4Abi, segmentedALCLaunchFactoryV3Abi } from '@ammora-protocol/sdk';
import { createPublicClient, defineChain, erc20Abi, http, toFunctionSelector } from 'viem';

const rpc = 'https://sepolia-rpc.giwa.io';
const deployment = giwaSepoliaAutoRouteDeployment;
const registry = deployment.contracts.launch.configRegistry;
const client = createPublicClient({ chain: defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }), transport: http(rpc, { timeout: 12000, retryCount: 0 }) });
const errorText = error => `${error.name}: ${error.message}`;
const getAbi = abi => abi.find(item => item.type === 'function' && item.name === 'get');
const launchAbi = abi => abi.find(item => item.type === 'function' && item.name === 'createLaunchWithTokenConfig');
const report = { utc: new Date().toISOString(), chainId: 91342, generation: 'auto-route', registry, factory: deployment.contracts.launch.factory, sdk: '0.3.9', abi: {
  v3GetOutputFields: getAbi(segmentedALCConfigRegistryV3Abi).outputs[0].components.map(x => x.name),
  v4GetOutputFields: getAbi(ammoraLaunchConfigRegistryV4Abi).outputs[0].components.map(x => x.name),
  v3LaunchSelector: launchAbi(segmentedALCLaunchFactoryV3Abi) ? toFunctionSelector(launchAbi(segmentedALCLaunchFactoryV3Abi)) : null,
  v4LaunchSelector: launchAbi(ammoraLaunchFactoryV4Abi) ? toFunctionSelector(launchAbi(ammoraLaunchFactoryV4Abi)) : null
}, configs: {} };
try {
  report.blockNumber = String(await client.getBlockNumber());
  const blockNumber = BigInt(report.blockNumber);
  report.nextConfigId = String(await getAmmoraV4NextConfigId(client, registry, blockNumber));
  for (const id of [1n, 2n, 3n, 4n, 5n, 6n, 10n]) {
    if (id >= BigInt(report.nextConfigId)) continue;
    try {
      const snapshot = await getAmmoraV4ConfigAtBlock(client, registry, id, blockNumber);
      let quoteDecimals = null;
      try { quoteDecimals = await client.readContract({ address: snapshot.config.quoteToken, abi: erc20Abi, functionName: 'decimals', blockNumber }); } catch (error) { quoteDecimals = errorText(error); }
      report.configs[id] = { status: 'PASS', snapshot, quoteDecimals };
    } catch (error) { report.configs[id] = { status: 'FAIL', error: errorText(error) }; }
  }
} catch (error) { report.fatal = errorText(error); }
await mkdir('fixtures/onchain', { recursive: true });
const path = `fixtures/onchain/v4-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(path, JSON.stringify(report, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
console.log(path);
if (report.fatal || !Object.values(report.configs).some(x => x.status === 'PASS')) process.exitCode = 2;
