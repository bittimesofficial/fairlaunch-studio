import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionData, decodeFunctionResult, defineChain, erc20Abi, getAddress, http, keccak256, parseAbi, serializeTransaction } from 'viem';
import {
  ammoraLaunchConfigRegistryV4Abi, ammoraLaunchFactoryV4Abi, buildCreateAmmoraV4Config,
  buildCreateAmmoraV4Launch, getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId,
  giwaSepoliaAtomicLaunchDeployment, giwaSepoliaAutoRouteDeployment,
  parseAmmoraV4ConfigCreatedReceipt, verifyAmmoraPortableDeploymentAtBlock,
} from '@ammora-protocol/sdk';
import { deriveConcentratedPolicy } from './graduation-policy.mjs';
import { assertOneOwnerRoles, requireConfirmedConfigReceipt, validateMetadataUri, validateOwnerAddress } from './owner-preflight-guards.mjs';

// This file has no signer, wallet transport or RPC write method.
const endpoint = 'https://sepolia-rpc.giwa.io';
const chain = defineChain({ id: 91342, name: 'GIWA Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [endpoint] } } });
const client = createPublicClient({ chain, transport: http(endpoint, { timeout: 20_000, retryCount: 0 }) });
const deployment = giwaSepoliaAutoRouteDeployment.contracts.launch;
const registry = getAddress(deployment.configRegistry);
const factory = getAddress(deployment.factory);
const weth = getAddress('0x4200000000000000000000000000000000000006');
const gasPriceOracle = getAddress('0x420000000000000000000000000000000000000F');
const gasPriceOracleAbi = parseAbi(['function getL1Fee(bytes) view returns (uint256)']);
const templateHash = '0xec0f91c5bf2943454abdc139170e5ea204a38fc1e102541a6a27224ec881a293';
const approvedMetadataBytes = readFileSync(new URL('../fixtures/metadata/fltest/v1/FLTEST.json', import.meta.url));
const approvedMetadata = JSON.parse(approvedMetadataBytes.toString('utf8'));
const approvedMetadataSha256 = createHash('sha256').update(approvedMetadataBytes).digest('hex');
if (approvedMetadataSha256 !== 'c8421af3a27fb87c1d29196a1039783062b1cd2c9da0f467b55be6c8c3a56d2e') throw new Error('Approved FLTEST v1 metadata changed; review a new version');
const pins = giwaSepoliaAtomicLaunchDeployment.security.runtimeCodeHashes;
const args = process.argv.slice(2);
const permitted = new Set(['--phase', '--owner', '--metadata-uri', '--config-receipt']);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const phase = flag('--phase') ?? 'config';
const stringify = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2);
const report = {
  utc: new Date().toISOString(), label: 'GIWA_PUBLIC_READ_ONLY', sdk: '0.3.9', endpoint,
  phase, status: 'BLOCKED', stages: {}, blockers: [], input: { owner: flag('--owner') ?? null, metadataURI: flag('--metadata-uri') ?? null, configReceipt: flag('--config-receipt') ?? null },
};
const fail = message => { report.blockers.push(message); throw new Error(message); };
const save = () => {
  const path = `fixtures/onchain/owner-preflight-${new Date().toISOString().replaceAll(':', '-')}.json`;
  writeFileSync(path, stringify(report) + '\n');
  console.log(path);
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function readMetadata(uri, owner) {
  const host = new URL(uri).hostname;
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(item => item.address.includes(':') ?
    /^(::1|fc|fd|fe80|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.)/i.test(item.address) :
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address))) fail('Metadata hostname resolves to a non-public address');
  const response = await fetch(uri, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
  if (response.status !== 200 || !/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) fail(`Metadata GET must be direct HTTP 200 JSON; got ${response.status}`);
  if (Number(response.headers.get('content-length') ?? 0) > 3_000_000) fail('Metadata JSON exceeds 3 MB');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 3_000_000) { await reader.cancel(); fail('Metadata JSON exceeds 3 MB'); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks);
  const data = JSON.parse(body.toString('utf8'));
  if (typeof data.name !== 'string' || data.name.trim().length < 2 || data.name.length > 60 ||
      typeof data.symbol !== 'string' || !/^[A-Za-z0-9]{2,12}$/.test(data.symbol) ||
      typeof data.description !== 'string' || data.description.length > 280 ||
      !['Meme & Community', 'Product & Utility', 'RWA & Other'].includes(data.category)) fail('Metadata fields do not match the app token schema');
  if (data.chainId != null && data.chainId !== 91342 || data.token != null || data.creator && getAddress(data.creator) !== owner) fail('Metadata chain, token or creator is inconsistent');
  if (data.image && !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data.image) && !/^https:\/\//.test(data.image)) fail('Metadata image is not a supported durable image reference');
  const sha256 = createHash('sha256').update(body).digest('hex');
  if (sha256 !== approvedMetadataSha256 || data.name !== approvedMetadata.name || data.symbol !== approvedMetadata.symbol || data.description !== approvedMetadata.description || data.chainId !== 91342) fail('Published metadata differs from approved FLTEST v1 bytes');
  return { uri, httpStatus: response.status, finalUrl: response.url, sha256, bytes: size, contentType: response.headers.get('content-type'), etag: response.headers.get('etag'), cacheControl: response.headers.get('cache-control'), name: data.name.trim(), symbol: data.symbol, description: data.description, category: data.category, creatorField: data.creator ?? null, ownerControl: 'OWNER_ATTESTATION_REQUIRED' };
}

async function main() {
try {
  for (let index = 0; index < args.length; index += 2) if (!permitted.has(args[index]) || !args[index + 1] || args[index + 1].startsWith('--')) fail('Unknown or incomplete argument');
  if (!['config', 'launch'].includes(phase)) fail('Phase must be config or launch');
  requireConfirmedConfigReceipt(phase, flag('--config-receipt'));
  if (phase === 'config' && flag('--config-receipt')) fail('Config receipt already exists; use --phase launch and reconcile it');
  const chainId = await client.getChainId();
  const block = await client.getBlock({ blockTag: 'latest' });
  report.chain = { chainId, blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp };
  if (chainId !== 91342) fail('Wrong public chain');
  report.stages.chain = 'PASS';
  report.runtime = {};
  for (const address of [factory, registry, deployment.firstBuyExecutor]) {
    const code = await client.getCode({ address, blockNumber: block.number });
    const hash = code && code !== '0x' ? keccak256(code) : null;
    const expected = pins[address.toLowerCase()];
    report.runtime[address] = { hash, expected, match: hash === expected };
    if (!expected || hash !== expected) fail(`Runtime pin mismatch: ${address}`);
    await pause(250);
  }
  report.stages.runtime = 'PASS';
  const attestation = await verifyAmmoraPortableDeploymentAtBlock(client, giwaSepoliaAtomicLaunchDeployment, block.number);
  report.attestation = { chainId: attestation.chainId, blockNumber: attestation.blockNumber, profile: 'SDK 0.3.9 portable atomic-launch' };
  report.stages.attestation = 'PASS';
  await pause(600);
  const nextConfigId = await getAmmoraV4NextConfigId(client, registry, block.number);
  const template = await getAmmoraV4ConfigAtBlock(client, registry, 10n, block.number);
  const quoteDecimals = await client.readContract({ address: weth, abi: erc20Abi, functionName: 'decimals', blockNumber: block.number });
  report.registry = { address: registry, nextConfigId, templateId: 10n, templateHash: template.configHash, templateEnabled: template.enabled, quoteToken: template.config.quoteToken, quoteDecimals };
  if (!template.enabled || template.configHash.toLowerCase() !== templateHash || template.config.quoteToken.toLowerCase() !== weth.toLowerCase() || quoteDecimals !== 18) fail('Pinned Config A source template or WETH changed');
  report.stages.registry = 'PASS';

  let owner; let metadataURI;
  try { owner = validateOwnerAddress(flag('--owner')); } catch (error) { report.blockers.push(error.message); }
  if (flag('--metadata-uri')) try { metadataURI = validateMetadataUri(flag('--metadata-uri')); } catch (error) { report.blockers.push(error.message); }
  if (phase === 'launch' && !metadataURI) report.blockers.push('A published permanent HTTPS metadata URI is required for launch planning');
  if (!owner || phase === 'launch' && !metadataURI || flag('--metadata-uri') && !metadataURI) {
    report.stages.ownerInputs = 'BLOCKED';
    report.stages.ownerState = 'BLOCKED';
    report.stages.metadataHttp = 'BLOCKED';
    report.stages.planA = 'BLOCKED';
    report.stages.planB = 'BLOCKED_UNTIL_CONFIG_RECEIPT';
    return;
  }
  report.input = { owner, metadataURI: metadataURI ?? null, configReceipt: flag('--config-receipt') ?? null };
  const ownerCode = await client.getCode({ address: owner, blockNumber: block.number });
  if (ownerCode && ownerCode !== '0x') fail('One-owner preflight requires an EOA; contract wallets need a reviewed caller path');
  report.ownerState = {
    accountCode: ownerCode ?? '0x',
    nonceLatest: await client.getTransactionCount({ address: owner, blockTag: 'latest' }),
    noncePending: await client.getTransactionCount({ address: owner, blockTag: 'pending' }),
    ethBalance: await client.getBalance({ address: owner, blockNumber: block.number }),
    wethBalance: await client.readContract({ address: weth, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber: block.number }),
  };
  if (report.ownerState.noncePending !== report.ownerState.nonceLatest) fail('Owner has a pending transaction; reconcile its hash and receipt before planning');
  report.stages.ownerState = 'PASS';
  report.metadataSource = { file: 'fixtures/metadata/fltest/v1/FLTEST.json', sha256: approvedMetadataSha256, publishedURI: metadataURI ?? null };
  if (phase === 'launch' || metadataURI) {
    report.metadata = await readMetadata(metadataURI, owner);
    report.stages.metadataHttp = 'PASS';
  } else report.stages.metadataHttp = 'BLOCKED_UNTIL_PUBLICATION';
  const recipients = { partnerRecipient: owner, liquidityPartner: owner, leftoverReceiver: owner };
  const { config, curve, economics } = deriveConcentratedPolicy(template.config, 1000000000000000n, 5000000000000000n, recipients);
  report.policy = { name: 'Config A', sourceTemplateId: 10n, sourceTemplateHash: template.configHash, config, curve, economics, roles: { configOwner: owner, creator: owner, partnerFeeRecipient: owner, partnerLpOwner: owner, leftoverReceiver: owner } };
  if (config.totalSupply !== 1124737525000000n || config.migrationBaseThreshold !== 123502500000000n || config.migrationQuoteThreshold !== 5000000000000000n || config.liquidityDistribution.creatorPermanentLockedBps !== 1000) fail('Config A economics changed');
  report.stages.policy = 'PASS';
  const fee = await client.estimateFeesPerGas();
  const gasPrice = fee.maxFeePerGas ?? fee.gasPrice;
  if (!gasPrice || gasPrice <= 0n) fail('Unable to derive a gas price bound');
  report.feeEstimate = { ...fee, priceUsed: gasPrice, note: 'Execution gas only; final wallet fee and any L1/data fee must be rechecked' };

  if (phase === 'config') {
    const built = buildCreateAmmoraV4Config(config, curve, owner);
    const decoded = decodeFunctionData({ abi: ammoraLaunchConfigRegistryV4Abi, data: built.data });
    if (decoded.functionName !== 'createConfig' || !decoded.args) fail('Config calldata selector mismatch');
    assertOneOwnerRoles(decoded.args[0], decoded.args[2], owner);
    if (stringify(decoded.args[0]) !== stringify(config) || stringify(decoded.args[1]) !== stringify(curve)) fail('Config calldata round-trip mismatch');
    const call = await client.call({ account: owner, to: registry, data: built.data, value: 0n, blockNumber: block.number });
    const simulated = decodeFunctionResult({ abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'createConfig', data: call.data });
    const gas = await client.estimateGas({ account: owner, to: registry, data: built.data, value: 0n, blockNumber: block.number });
    const gasLimitReview = (gas * 120n + 99n) / 100n;
    const gasReserve = gasLimitReview * gasPrice;
    const unsignedTx = serializeTransaction({ type: 'eip1559', chainId: 91342, nonce: report.ownerState.nonceLatest, gas: gasLimitReview, maxFeePerGas: gasPrice, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? 0n, to: registry, value: 0n, data: built.data });
    const l1FeeEstimate = await client.readContract({ address: gasPriceOracle, abi: gasPriceOracleAbi, functionName: 'getL1Fee', args: [unsignedTx], blockNumber: block.number });
    const l1ReviewReserve = l1FeeEstimate * 2n;
    const totalReviewReserve = gasReserve + l1ReviewReserve;
    const ethDeficit = report.ownerState.ethBalance < totalReviewReserve ? totalReviewReserve - report.ownerState.ethBalance : 0n;
    report.planA = { status: ethDeficit ? 'BLOCKED_INSUFFICIENT_ETH' : 'UNSIGNED_REVIEW_ONLY', chainId: 91342, from: owner, to: registry, data: built.data, value: 0n, gasEstimate: gas, gasLimitReview, gasPriceBound: gasPrice, estimatedExecutionCostWei: gas * gasPrice, reviewGasReserveWei: gasReserve, l1FeeOracle: gasPriceOracle, unsignedTxBytes: (unsignedTx.length - 2) / 2, l1FeeEstimateWei: l1FeeEstimate, l1ReviewReserveWei: l1ReviewReserve, totalReviewReserveWei: totalReviewReserve, ethDeficitWei: ethDeficit, feeCaveat: 'Requote at signing; L1/data fee is variable and 2x the oracle sample is a planning margin, not a protocol cap', spender: null, approval: 'none', nonceAtRead: report.ownerState.nonceLatest, provisionalNextConfigId: nextConfigId, simulatedReturn: simulated, expectedEvent: 'ConfigCreated', decoded: { functionName: decoded.functionName, configOwner: decoded.args[2], partnerRecipient: decoded.args[0].partnerRecipient, partnerLpOwner: decoded.args[0].liquidityDistribution.partner, leftoverReceiver: decoded.args[0].leftoverReceiver }, calldataHash: keccak256(built.data), asOfBlock: block.number, asOfBlockHash: block.hash };
    if (ethDeficit) fail(`Owner ETH deficit for reviewed Config gas reserve: ${ethDeficit} wei`);
    report.stages.planA = 'PASS';
    report.stages.planB = 'BLOCKED_UNTIL_CONFIG_RECEIPT';
  } else {
    const hash = flag('--config-receipt');
    const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash }), client.getTransaction({ hash })]);
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (receipt.status !== 'success' || !receipt.to || getAddress(receipt.to) !== registry || getAddress(transaction.from) !== owner || transaction.value !== 0n || receipt.blockHash !== canonical.hash || block.number - receipt.blockNumber < 12n) fail('Config receipt not successful, canonical, owner-sent or 12 blocks confirmed');
    const expectedConfigInput = buildCreateAmmoraV4Config(config, curve, owner).data;
    if (keccak256(transaction.input) !== keccak256(expectedConfigInput)) fail('Confirmed Config transaction calldata differs from approved owner-specific Config A');
    const event = parseAmmoraV4ConfigCreatedReceipt(receipt, registry);
    const actual = await getAmmoraV4ConfigAtBlock(client, registry, event.configId, block.number);
    if (event.owner.toLowerCase() !== owner.toLowerCase() || event.feeClaimer.toLowerCase() !== owner.toLowerCase() || actual.identity.owner.toLowerCase() !== owner.toLowerCase() || !actual.enabled || actual.configHash.toLowerCase() !== event.configHash.toLowerCase() || stringify(actual.config) !== stringify(config) || stringify(actual.segments) !== stringify(curve)) fail('Confirmed Config differs from owner-specific Config A');
    report.confirmedConfig = { transactionHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, confirmations: block.number - receipt.blockNumber + 1n, configId: event.configId, configHash: event.configHash, owner: event.owner };
    report.stages.configReceipt = 'PASS';
    const built = buildCreateAmmoraV4Launch({ name: report.metadata.name, symbol: report.metadata.symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: config.tokenDecimals }, event.configId, config.poolCreationFee);
    const decoded = decodeFunctionData({ abi: ammoraLaunchFactoryV4Abi, data: built.data });
    if (decoded.functionName !== 'createLaunchWithTokenConfig' || !decoded.args || decoded.args[0] !== report.metadata.name || decoded.args[1] !== report.metadata.symbol || decoded.args[2] !== metadataURI || decoded.args[3] !== metadataURI || decoded.args[4] !== event.configId || decoded.args[5] !== config.tokenDecimals) fail('No-first-buy launch calldata mismatch');
    await client.call({ account: owner, to: factory, data: built.data, value: built.value, blockNumber: block.number });
    const gas = await client.estimateGas({ account: owner, to: factory, data: built.data, value: built.value, blockNumber: block.number });
    const costUpperBound = gas * gasPrice + built.value;
    report.planB = { status: 'UNSIGNED_REVIEW_ONLY', chainId: 91342, from: owner, to: factory, data: built.data, value: built.value, gasEstimate: gas, gasPriceBound: gasPrice, executionGasCostBoundWei: gas * gasPrice, totalExecutionCostBoundWei: costUpperBound, spender: null, approval: 'none; first buy excluded', nonceAtRead: report.ownerState.nonceLatest, configId: event.configId, configHash: event.configHash, expectedEvent: 'LaunchCreated', decoded: { functionName: decoded.functionName, name: decoded.args[0], symbol: decoded.args[1], metadataURI: decoded.args[2], creatorMetadataURI: decoded.args[3], configId: decoded.args[4], tokenDecimals: decoded.args[5], expectedCreator: owner }, calldataHash: keccak256(built.data), asOfBlock: block.number, asOfBlockHash: block.hash };
    if (report.ownerState.ethBalance < costUpperBound) fail('Owner ETH balance below estimated launch execution cost bound');
    report.stages.planB = 'PASS';
  }
  report.status = 'OWNER_REVIEW_REQUIRED';
} catch (error) {
  if (!report.blockers.includes(error.message)) report.blockers.push(error.message);
  report.status = 'BLOCKED';
} finally {
  save();
  if (report.status === 'BLOCKED') process.exitCode = 2;
}
}

await main();
