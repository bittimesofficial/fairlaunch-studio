import { writeFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionData, defineChain, erc20Abi, http, getAddress } from 'viem';
import {
  ammoraLaunchConfigRegistryV4Abi, buildCreateAmmoraV4Config, buildCreateAmmoraV4Launch,
  concentratedDepositQuote, maxBaseOutput, previewAmmoraLiquidityMigrationFee,
  getAmmoraV4ConfigAtBlock, giwaSepoliaAutoRouteDeployment, planCreateAmmoraV4Config,
  segmentedALCLaunchFactoryV3Abi,
} from '@ammora-protocol/sdk';
import { deriveConcentratedPolicy } from './graduation-policy.mjs';

const rpc = process.env.GIWA_RPC_URL || 'https://sepolia-rpc.giwa.io';
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const client = createPublicClient({ chain, transport: http(rpc, { timeout: 15000, retryCount: 1 }) });
const registry = getAddress(giwaSepoliaAutoRouteDeployment.contracts.launch.configRegistry);
const factory = getAddress(giwaSepoliaAutoRouteDeployment.contracts.launch.factory);
// Technical stand-ins only. These addresses are never eligible for real submission.
const recipients = { partnerRecipient: getAddress('0x1111111111111111111111111111111111111111'), liquidityPartner: getAddress('0x2222222222222222222222222222222222222222'), leftoverReceiver: getAddress('0x3333333333333333333333333333333333333333') };
const owner = getAddress('0x4444444444444444444444444444444444444444');
const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
const report = { utc: new Date().toISOString(), chainId: 91342, registry, factory, sdk: '0.3.9', status: 'TECHNICAL_ONLY', addresses: { ...recipients, configOwner: owner, temporary: true }, variants: [] };
try {
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  if (chainId !== 91342) throw new Error(`Wrong chain ${chainId}`);
  report.blockNumber = blockNumber;
  const affected = await getAmmoraV4ConfigAtBlock(client, registry, 6n, blockNumber);
  const affectedSold = maxBaseOutput(affected.segments, affected.config.startSqrtPrice);
  const affectedDestination = concentratedDepositQuote({ sqrtPriceX64: affected.segments.at(-1).upperSqrtPrice, sqrtMinPriceX64: affected.config.postMigrationSqrtMinPrice, sqrtMaxPriceX64: affected.config.postMigrationSqrtMaxPrice }, { quoteAmount: affected.config.migrationQuoteThreshold });
  report.affectedSix = { configHash: affected.configHash, totalSupplyRaw: affected.config.totalSupply, worstCaseCurveBaseSoldRaw: affectedSold, grossMigrationBaseRaw: affectedDestination.baseAmount, deficitRaw: affectedSold + affectedDestination.baseAmount - affected.config.totalSupply, quoteThresholdRaw: affected.config.migrationQuoteThreshold, migrationBaseThresholdRaw: affected.config.migrationBaseThreshold };
  report.existingConfigEconomics = [];
  for (const id of [1n, 2n, 3n, 4n, 5n, 10n]) {
    await new Promise(resolve => setTimeout(resolve, 600));
    const entry = { configId: id };
    try {
      const current = await getAmmoraV4ConfigAtBlock(client, registry, id, blockNumber);
      const sold = maxBaseOutput(current.segments, current.config.startSqrtPrice);
      const netQuote = previewAmmoraLiquidityMigrationFee(current.config.migrationQuoteThreshold - current.config.migrationQuoteThreshold * BigInt(current.config.migrationQuoteFeeBps) / 10000n).amountAfterFee;
      const required = concentratedDepositQuote({ sqrtPriceX64: current.segments.at(-1).upperSqrtPrice, sqrtMinPriceX64: current.config.postMigrationSqrtMinPrice, sqrtMaxPriceX64: current.config.postMigrationSqrtMaxPrice }, { quoteAmount: netQuote });
      entry.configHash = current.configHash; entry.enabled = current.enabled; entry.totalSupplyRaw = current.config.totalSupply; entry.worstCaseCurveBaseSoldRaw = sold; entry.netQuoteRaw = netQuote; entry.destinationBaseRawAtNetQuote = required.baseAmount; entry.baseMarginRaw = current.config.totalSupply - sold - required.baseAmount; entry.migrationBaseThresholdRaw = current.config.migrationBaseThreshold;
    } catch (error) { entry.error = String(error); }
    report.existingConfigEconomics.push(entry);
  }
  const template = await getAmmoraV4ConfigAtBlock(client, registry, 10n, blockNumber);
  report.template = { configId: template.configId, configHash: template.configHash, enabled: template.enabled, asOfBlock: template.asOfBlock, quoteToken: template.config.quoteToken, tokenDecimals: template.config.tokenDecimals };
  report.template.quoteDecimals = await client.readContract({ address: template.config.quoteToken, abi: erc20Abi, functionName: 'decimals', blockNumber });
  if (!template.enabled || template.config.quoteToken.toLowerCase() !== '0x4200000000000000000000000000000000000006') throw new Error('Unexpected WETH template');
  for (const [name, saleSupplyRaw, quoteThresholdRaw] of [['A', 1000000000000000n, 5000000000000000n], ['B', 10000000000000000n, 50000000000000000n]]) {
    const result = { name, saleSupplyRaw, quoteThresholdRaw };
    try {
      const { config, curve, economics } = deriveConcentratedPolicy(template.config, saleSupplyRaw, quoteThresholdRaw, recipients);
      result.config = config; result.curve = curve; result.economics = economics;
      const built = buildCreateAmmoraV4Config(config, curve, owner);
      const decoded = decodeFunctionData({ abi: ammoraLaunchConfigRegistryV4Abi, data: built.data });
      if (decoded.functionName !== 'createConfig' || stringify(decoded.args[0]) !== stringify(config) || stringify(decoded.args[1]) !== stringify(curve) || decoded.args[2].toLowerCase() !== owner.toLowerCase()) throw new Error('Config calldata round-trip mismatch');
      result.configCreation = { to: registry, value: '0', calldata: built.data, functionName: decoded.functionName, decodedOwner: decoded.args[2], calldataBytes: (built.data.length - 2) / 2 };
      try { result.configCreation.estimatedGas = await client.estimateGas({ account: owner, to: registry, data: built.data, value: 0n }); }
      catch (error) { result.configCreation.estimateGasError = String(error); }
      try {
        const plan = await planCreateAmmoraV4Config(client, registry, config, curve, owner, owner);
        result.simulation = { status: 'PASS', expectedConfigId: plan.expectedConfigId, simulatedConfigId: plan.simulatedConfigId, simulatedConfigHash: plan.simulatedConfigHash, feePolicy: plan.feePolicy, feePolicyVersion: plan.feePolicyVersion, asOfBlock: plan.asOfBlock };
        const metadataURI = 'https://example.invalid/fairlaunch-technical-preview.json';
        const launch = buildCreateAmmoraV4Launch({ name: 'FairLaunch Technical Preview', symbol: 'FLTP', metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: config.tokenDecimals }, plan.expectedConfigId, config.poolCreationFee);
        const decodedLaunch = decodeFunctionData({ abi: segmentedALCLaunchFactoryV3Abi, data: launch.data });
        if (decodedLaunch.functionName !== 'createLaunchWithTokenConfig' || decodedLaunch.args[4] !== plan.expectedConfigId || decodedLaunch.args[3] !== metadataURI) throw new Error('Launch calldata round-trip mismatch');
        result.tokenLaunch = { to: factory, value: launch.value, calldata: launch.data, functionName: decodedLaunch.functionName, decodedArgs: decodedLaunch.args, temporaryMetadata: true };
      } catch (error) { result.simulation = { status: 'FAIL', error: String(error) }; }
    } catch (error) { result.status = 'FAIL'; result.error = String(error); }
    report.variants.push(result);
  }
} catch (error) { report.error = String(error); }
const file = `fixtures/onchain/graduation-preview-${new Date().toISOString().replaceAll(':', '-')}.json`;
writeFileSync(file, stringify(report) + '\n');
console.log(stringify({ file, blockNumber: report.blockNumber, template: report.template, variants: report.variants.map(({ name, economics, simulation, status, error }) => ({ name, economics, simulation, status, error })), error: report.error }));
if (report.error || report.variants.some(v => v.status === 'FAIL')) process.exitCode = 1;
