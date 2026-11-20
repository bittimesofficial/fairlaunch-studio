import { getAddress, parseEventLogs, type Address, type Hex } from 'viem';
import { publicClient, factory, segmentedALCLaunchFactoryV3Abi } from './chain';

export type Launch = { token: Address; curve: Address; creator: Address; configId: string; metadataURI: string; hash: Hex; block: string; timestamp?: string };
type State = { nextBlock: string; launches: Launch[] };
const launchHash = '0xb545d385db7e2962057e0c09e1f2b404efed8d0835eb3ffe0a9cd5b9662efad4' as Hex;
const token = getAddress('0x4362c5575918c819122f1A76510130337320cd9C');
const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const metadataURI = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
let cached: { at: number; value: State } | undefined;
let job: Promise<State> | undefined;

async function readConfirmedLaunch(): Promise<State> {
  const [head, receipt] = await Promise.all([
    publicClient.getBlockNumber(),
    publicClient.getTransactionReceipt({ hash: launchHash }),
  ]);
  if (receipt.status !== 'success' || !receipt.to || receipt.to.toLowerCase() !== factory.toLowerCase() || head - receipt.blockNumber + 1n < 12n) throw new Error('FLTEST launch receipt is not final and successful');
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
  if (block.hash !== receipt.blockHash) throw new Error('FLTEST launch receipt is not canonical');
  const events = parseEventLogs({ abi: segmentedALCLaunchFactoryV3Abi, eventName: 'LaunchCreated', logs: receipt.logs.filter(log => log.address.toLowerCase() === factory.toLowerCase()) });
  const event = events.find(log => log.args.token?.toLowerCase() === token.toLowerCase() && log.args.creator?.toLowerCase() === owner.toLowerCase() && log.args.configId === 63n && log.args.metadataURI === metadataURI);
  if (!event || !event.args.token || !event.args.curve || !event.args.creator) throw new Error('FLTEST Factory event mismatch');
  return { nextBlock: String(head + 1n), launches: [{ token: getAddress(event.args.token), curve: getAddress(event.args.curve), creator: getAddress(event.args.creator), configId: '63', metadataURI, hash: launchHash, block: String(receipt.blockNumber) }] };
}

export async function getCatalog(): Promise<State> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  if (!job) job = readConfirmedLaunch().then(value => { cached = { at: Date.now(), value }; return value; }).finally(() => { job = undefined; });
  return job;
}
