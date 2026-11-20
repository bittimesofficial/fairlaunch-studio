import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALCClient, AmmoraDataApiClient, ammoraLaunchFactoryV4Abi, buildCreateAmmoraV4Launch, getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId, giwaSepoliaAtomicLaunchDeployment, giwaSepoliaAutoRouteDeployment, segmentedALCLaunchFactoryV3Abi, verifyAmmoraPortableDeploymentAtBlock } from '@ammora-protocol/sdk';
import { createPublicClient, decodeFunctionData, defineChain, erc20Abi, getAddress, http, isAddress, keccak256, parseEventLogs, parseUnits, type Address } from 'viem';

// Read-only. No wallet, signer, eth_sendTransaction, or approval call is used.
const endpoint = 'https://sepolia-rpc.giwa.io';
const dataEndpoint = 'https://ammora-giwa-sepolia-data.fly.dev';
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [endpoint] } } });
const client = createPublicClient({ chain, transport: http(endpoint, { timeout: 10_000, retryCount: 0 }) });
const deployment = giwaSepoliaAutoRouteDeployment;
const factory = deployment.contracts.launch.factory as Address;
const registry = deployment.contracts.launch.configRegistry as Address;
const helper = deployment.contracts.launch.firstBuyExecutor as Address;
const flag = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const creatorInput = flag('--creator');
const creator = creatorInput && isAddress(creatorInput) ? getAddress(creatorInput) : undefined;
const metadataURI = flag('--metadata-uri');
const launchName = flag('--name') || 'FairLaunch Review';
const launchSymbol = flag('--symbol') || 'FLREV';
const firstBuyInput = flag('--first-buy-quote');
const report: Record<string, unknown> = {
  utc: new Date().toISOString(), endpoint, dataEndpoint, chainIdExpected: 91342,
  package: { sdk: '0.3.9', deploymentStartBlock: String(deployment.startBlock), factory, registry, firstBuyHelper: helper },
  requestedPreview: { creator: creator ?? null, metadataURI: metadataURI ?? null, launchName, launchSymbol, firstBuyInput: firstBuyInput ?? null },
  stages: { R0: 'BLOCKED', R1: 'BLOCKED', R2: 'BLOCKED', R3: 'BLOCKED', R4: 'BLOCKED', R4a: 'BLOCKED', R4b: 'SKIP', R5: 'SKIP', R6: 'SKIP', R7: 'SKIP' },
};
const stages = report.stages as Record<string, string>;
const errors: Record<string, string> = {};
const replaceBigInt = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;
const save = async () => {
  const directory = join(process.cwd(), 'fixtures', 'onchain');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `sdk-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await writeFile(file, JSON.stringify({ ...report, errors, completedUtc: new Date().toISOString() }, replaceBigInt, 2), 'utf8');
  console.log(`Evidence: ${file}`);
};
const failure = (error: unknown) => error instanceof Error ? `${error.name}: ${error.message}` : String(error);

async function main() {
  try {
    const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
    report.chainId = chainId; report.blockNumber = String(blockNumber);
    if (chainId !== 91342) throw new Error(`Wrong chain ID ${chainId}`);
    stages.R0 = 'PASS';
    const addresses = [factory, registry, helper];
    const pins = giwaSepoliaAtomicLaunchDeployment.security.runtimeCodeHashes as Record<string, string>;
    const runtime: Record<string, unknown> = {};
    for (const address of addresses) {
      const code = await client.getCode({ address, blockNumber });
      const hash = code && code !== '0x' ? keccak256(code) : null;
      const implementationSlot = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
      const storage = await client.getStorageAt({ address, slot: implementationSlot, blockNumber });
      const implementation = storage && BigInt(storage) !== 0n ? getAddress(`0x${storage.slice(-40)}`) : null;
      const implementationCode = implementation ? await client.getCode({ address: implementation, blockNumber }) : undefined;
      runtime[address] = { code, hash, expectedHash: pins[address.toLowerCase()] ?? null, pinMatch: hash !== null && hash === pins[address.toLowerCase()], eip1967Implementation: implementation, implementationHash: implementationCode && implementationCode !== '0x' ? keccak256(implementationCode) : null };
    }
    report.runtime = runtime;
    stages.R1 = Object.values(runtime).every(value => (value as { pinMatch: boolean }).pinMatch) ? 'PASS' : 'FAIL';
    if (stages.R1 !== 'PASS') throw new Error('Runtime hash mismatch or missing code');
    try {
      const attestation = await verifyAmmoraPortableDeploymentAtBlock(client, giwaSepoliaAtomicLaunchDeployment, blockNumber);
      report.attestation = { chainId: attestation.chainId, blockNumber: String(attestation.blockNumber), verifier: 'verifyAmmoraPortableDeploymentAtBlock' };
      stages.R2 = 'PASS';
    } catch (error) { errors.R2 = failure(error); stages.R2 = 'FAIL'; }
    try {
      const nextConfigId = await getAmmoraV4NextConfigId(client, registry, blockNumber);
      const inspectedIds = [1n, 2n, 3n, 4n, 5n, 6n, 10n].filter(id => id < nextConfigId);
      const configs: Awaited<ReturnType<typeof getAmmoraV4ConfigAtBlock>>[] = [];
      for (const id of inspectedIds) {
        if (configs.length) await new Promise(resolve => setTimeout(resolve, 600));
        configs.push(await getAmmoraV4ConfigAtBlock(client, registry, id, blockNumber));
      }
      report.configs = { generation: 'auto-route-v4', nextConfigId, inspected: configs.map(({ configId, configHash, enabled, config, identity }) => ({ configId, configHash, enabled, identity, quoteToken: config.quoteToken, tokenDecimals: config.tokenDecimals, poolCreationFee: config.poolCreationFee, migrationQuoteThreshold: config.migrationQuoteThreshold, migrationBaseThreshold: config.migrationBaseThreshold, migrationMode: config.migrationMode })) };
      stages.R3 = configs.some(item => item.enabled) ? 'PASS' : 'BLOCKED';
      const candidate = configs.find(item => item.configId === 10n);
      if (candidate) {
        const quoteDecimals = await client.readContract({ address: candidate.config.quoteToken, abi: erc20Abi, functionName: 'decimals', blockNumber });
        const uri = 'https://example.test/technical-preview-only';
        const built = buildCreateAmmoraV4Launch({ name: 'Technical preview', symbol: 'TECH', metadataURI: uri, creatorMetadataURI: uri, tokenDecimals: candidate.config.tokenDecimals }, candidate.configId, candidate.config.poolCreationFee);
        const decoded = decodeFunctionData({ abi: ammoraLaunchFactoryV4Abi, data: built.data });
        if (decoded.functionName !== 'createLaunchWithTokenConfig' || decoded.args?.[4] !== candidate.configId || built.value !== candidate.config.poolCreationFee) throw new Error('V4 unsigned builder mismatch');
        report.technicalPreview = { safeForLaunch: false, reason: 'Config #10 is only a historical graduation observation; URI is illustrative', target: factory, transaction: built, decodedFunction: decoded.functionName, configId: candidate.configId, configHash: candidate.configHash, chainId: 91342, quoteToken: candidate.config.quoteToken, quoteDecimals, approval: 'none without first buy', deadline: 'none without first buy' };
        stages.R4b = 'PASS';
      }
      report.launchPlanPrerequisites = 'A graduation-qualified Config policy, actual Creator public address and persistent metadata URI are required for R5. Config #6 is explicitly unsafe for new launches; #10 is not automatically qualified.';
    } catch (error) { errors.R3 = failure(error); stages.R3 = 'BLOCKED'; }
    const api = new AmmoraDataApiClient(dataEndpoint);
    try {
      const [indexer, launches] = await Promise.all([api.getIndexerStatus(), api.getLaunches({ chainId: 91342n })]);
      report.dataApi = { indexer, launches };
      stages.R4 = 'PASS'; stages.R4a = 'PASS';
      const candidate = launches.items.find(item => item.chainId === '91342' && item.createdTxHash && item.curveAddress && !item.blacklisted);
      if (candidate) {
        const receipt = await client.getTransactionReceipt({ hash: candidate.createdTxHash });
        const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
        const events = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, eventName: 'LaunchCreated', logs: receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()) });
        if (receipt.status !== 'success' || receipt.blockHash !== canonical.hash || !events.some(event => event.args.token.toLowerCase() === candidate.address.toLowerCase() && event.args.curve.toLowerCase() === candidate.curveAddress.toLowerCase())) throw new Error('Data API launch not confirmed by canonical Factory event');
        report.candidate = { ...candidate, canonicalReceipt: receipt.transactionHash };
        const curve = new ALCClient(client, candidate.curveAddress);
        const [state, progress] = await Promise.all([curve.getState(), curve.getMigrationProgress()]);
        report.market = { state, progress };
        const quoteDecimals = await client.readContract({ address: state.quoteToken, abi: erc20Abi, functionName: 'decimals' });
        const baseDecimals = await client.readContract({ address: state.baseToken, abi: erc20Abi, functionName: 'decimals' });
        report.decimals = { quote: quoteDecimals, base: baseDecimals };
        if (!progress.migrated && state.status === 1) {
          const buyAmount = parseUnits('0.001', quoteDecimals);
          const sellAmount = parseUnits('1', baseDecimals);
          report.quotes = { buy: await curve.quoteExactInput(buyAmount, false), sell: await curve.quoteExactInput(sellAmount, true) };
          if (creator) {
            const deadline = BigInt(Math.floor(Date.now() / 1000) + 180);
            report.swapPlans = { buy: await curve.planSwapExactInput({ includedAmountIn: buyAmount, baseForQuote: false, allowPartialFill: false, slippageBps: 100, recipient: creator, deadline }), sell: await curve.planSwapExactInput({ includedAmountIn: sellAmount, baseForQuote: true, allowPartialFill: false, slippageBps: 100, recipient: creator, deadline }) };
          }
          stages.R6 = 'PASS';
        } else if (progress.migrated) stages.R7 = 'BLOCKED';
      }
    } catch (error) { errors.R4 = failure(error); if (stages.R4 !== 'PASS') { stages.R4 = 'BLOCKED'; stages.R4a = 'BLOCKED'; } }
  } catch (error) { errors.fatal = failure(error); }
  await save();
  if (['R0', 'R1', 'R2', 'R3', 'R4b', 'R5'].some(stage => stages[stage] !== 'PASS')) process.exitCode = 2;
}
await main();
