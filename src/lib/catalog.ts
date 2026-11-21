import { getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import { publicClient, factory, segmentedALCLaunchFactoryV3Abi } from './chain';
import { redis } from './durable';
import { randomUUID } from 'node:crypto';

export type Launch = { token: Address; curve: Address; creator: Address; configId: string; metadataURI: string; hash: Hex; block: string; blockHash?: Hex; timestamp?: string };
type State = { nextBlock: string; anchorHash: Hex; launches: Launch[] };
const launchHash = '0xb545d385db7e2962057e0c09e1f2b404efed8d0835eb3ffe0a9cd5b9662efad4' as Hex;
const token = getAddress('0x4362c5575918c819122f1A76510130337320cd9C');
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const metadataURI = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
let cached: { at: number; value: State } | undefined;
let job: Promise<State> | undefined;

async function fltest(): Promise<{ launch: Launch; blockHash: Hex }> {
  const [head, receipt] = await Promise.all([publicClient.getBlockNumber(), publicClient.getTransactionReceipt({ hash: launchHash })]);
  if (receipt.status !== 'success' || receipt.to?.toLowerCase() !== factory.toLowerCase() || head - receipt.blockNumber + 1n < 12n) throw new Error('FLTEST launch receipt is not final and successful');
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error('FLTEST launch receipt is not canonical');
  const events = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, eventName: 'LaunchCreated', logs: receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()) });
  const event = events.find(log => log.args.token?.toLowerCase() === token.toLowerCase() && log.args.creator?.toLowerCase() === owner.toLowerCase() && log.args.configId === 63n && log.args.metadataURI === metadataURI);
  if (!event?.args.curve) throw new Error('FLTEST Factory event mismatch');
  return { launch: { token, curve: getAddress(event.args.curve), creator: owner, configId: '63', metadataURI, hash: launchHash, block: String(receipt.blockNumber) }, blockHash: receipt.blockHash };
}

async function scan(): Promise<State> {
  const pinned = await fltest();
  const start = BigInt(pinned.launch.block) + 1n;
  const fallback: State = { nextBlock: String(start), anchorHash: pinned.blockHash, launches: [pinned.launch] };
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return fallback;
  const raw = await redis<string>('GET', 'fairlaunch:catalog:v1');
  let state = raw ? JSON.parse(raw) as State : fallback;
  if (BigInt(state.nextBlock) < start) state = fallback;
  const lockId = randomUUID();
  const lock = await redis<string>('SET', 'fairlaunch:catalog:scan-lock', lockId, 'NX', 'EX', 60);
  if (lock !== 'OK') return state;
  try {
    const cursor = BigInt(state.nextBlock);
    const anchor = await publicClient.getBlock({ blockNumber: cursor - 1n });
    if (anchor.hash !== state.anchorHash) {
      const rewind = cursor > start + 24n ? cursor - 24n : start;
      const prior = await publicClient.getBlock({ blockNumber: rewind - 1n });
      state = { nextBlock: String(rewind), anchorHash: prior.hash!, launches: state.launches.filter(item => BigInt(item.block) < rewind) };
    }
    const head = await publicClient.getBlockNumber();
    if (head < 12n || BigInt(state.nextBlock) > head - 11n) return state;
    const from = BigInt(state.nextBlock);
    const to = from + 499n < head - 11n ? from + 499n : head - 11n;
    const logs = await publicClient.getLogs({ address: factory, fromBlock: from, toBlock: to });
    const events = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, eventName: 'LaunchCreated', logs, strict: true });
    const additions: Launch[] = [];
    for (const event of events) {
      if (!event.args.token || !event.args.curve || !event.args.creator || event.args.configId === undefined || !event.args.metadataURI) continue;
      const receipt = await publicClient.getTransactionReceipt({ hash: event.transactionHash });
      if (receipt.status !== 'success' || receipt.to?.toLowerCase() !== factory.toLowerCase() || receipt.blockHash !== event.blockHash) continue;
      additions.push({ token: getAddress(event.args.token), curve: getAddress(event.args.curve), creator: getAddress(event.args.creator), configId: String(event.args.configId), metadataURI: event.args.metadataURI, hash: event.transactionHash, block: String(event.blockNumber), blockHash: event.blockHash });
    }
    const end = await publicClient.getBlock({ blockNumber: to });
    state = { nextBlock: String(to + 1n), anchorHash: end.hash!, launches: [...state.launches, ...additions].filter((item, index, all) => all.findIndex(other => other.token.toLowerCase() === item.token.toLowerCase()) === index) };
    const saved = await redis<number>('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('SET',KEYS[2],ARGV[2]); return 1 else return 0 end", 2, 'fairlaunch:catalog:scan-lock', 'fairlaunch:catalog:v1', lockId, JSON.stringify(state));
    if (saved !== 1) throw new Error('Catalog scan lock expired');
    return state;
  } catch {
    // Keep the last durable cursor on RPC 429 or temporary failures.
    return raw ? JSON.parse(raw) as State : fallback;
  } finally { await redis('EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", 1, 'fairlaunch:catalog:scan-lock', lockId).catch(() => {}); }
}

async function withConfirmed(state: State): Promise<State> {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return state;
  const rows = await redis<string[]>('HVALS', 'fairlaunch:confirmed-launches').catch(() => []);
  const launches = [...state.launches];
  for (const raw of rows || []) {
    const item = JSON.parse(raw) as Launch;
    if (launches.some(launch => launch.token.toLowerCase() === item.token.toLowerCase())) continue;
    if (!item.blockHash) continue;
    try { const block = await publicClient.getBlock({ blockNumber: BigInt(item.block) }); if (block.hash === item.blockHash) launches.push(item); }
    catch { /* An unverified direct listing waits for RPC recovery. */ }
  }
  return { ...state, launches };
}

export async function getCatalog(): Promise<State> {
  if (cached && Date.now() - cached.at < 30_000) return withConfirmed(cached.value);
  if (!job) job = scan().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { job = undefined; });
  return withConfirmed(await job);
}
