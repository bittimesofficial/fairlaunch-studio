import { mkdir, writeFile } from 'node:fs/promises';
import { ALCClient, giwaSepoliaAutoRouteDeployment, segmentedALCConfigRegistryV3Abi } from '@ammora-protocol/sdk';
import { createPublicClient, defineChain, http } from 'viem';

const rpc = 'https://sepolia-rpc.giwa.io';
const api = 'https://ammora-giwa-sepolia-data.fly.dev';
const deployment = giwaSepoliaAutoRouteDeployment;
const registry = deployment.contracts.launch.configRegistry;
const client = createPublicClient({ chain: defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }), transport: http(rpc, { timeout: 10000, retryCount: 0 }) });
const sdk = new ALCClient(client, deployment.contracts.launch.factory, registry);
const result = { utc: new Date().toISOString(), rpc, api, registry, configs: {}, endpoints: {} };
const message = error => `${error.name}: ${error.message}`;
try {
  const next = await client.readContract({ address: registry, abi: segmentedALCConfigRegistryV3Abi, functionName: 'nextConfigId' });
  result.nextConfigId = String(next);
  for (let id = 1n; id < next && id <= 5n; id++) {
    try {
      const config = await sdk.getConfig(id);
      result.configs[id] = { status: 'PASS', enabled: config.enabled, quoteToken: config.config.quoteToken, poolCreationFee: config.config.poolCreationFee, tokenDecimals: config.config.tokenDecimals };
    } catch (error) { result.configs[id] = { status: 'FAIL', error: message(error) }; }
  }
} catch (error) { result.configError = message(error); }
for (const path of ['/v1/indexer/status', '/v1/tokens?chainId=91342']) {
  try {
    const response = await fetch(api + path, { signal: AbortSignal.timeout(12000) });
    result.endpoints[path] = { status: response.status, contentType: response.headers.get('content-type'), bodyStart: (await response.text()).slice(0, 500) };
  } catch (error) { result.endpoints[path] = { error: message(error) }; }
}
await mkdir('fixtures/onchain', { recursive: true });
const path = `fixtures/onchain/diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
await writeFile(path, JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2));
console.log(path);
