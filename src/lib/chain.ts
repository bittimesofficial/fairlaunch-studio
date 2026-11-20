import { ALCClient, giwaSepoliaAutoRouteDeployment, segmentedALCLaunchFactoryV3Abi } from '@ammora-protocol/sdk';
import { createPublicClient, http, defineChain, type Address } from 'viem';

export const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_GIWA_RPC_URL || 'https://sepolia-rpc.giwa.io'] } }, blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } } });
export const deployment = giwaSepoliaAutoRouteDeployment;
export const factory = deployment.contracts.launch.factory as Address;
export const registry = deployment.contracts.launch.configRegistry as Address;
export const startBlock = deployment.startBlock;
export const explorer = chain.blockExplorers.default.url;
export const publicClient = createPublicClient({ chain, cacheTime: 10_000, pollingInterval: 12_000, transport: http(chain.rpcUrls.default.http[0], { timeout: 9_000, retryCount: 1, retryDelay: 1_500 }) });
export const configClient = () => new ALCClient(publicClient, factory, registry);
export { segmentedALCLaunchFactoryV3Abi };
