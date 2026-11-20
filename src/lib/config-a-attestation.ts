import { getAmmoraV4ConfigAtBlock, parseAmmoraV4ConfigCreatedReceipt } from '@ammora-protocol/sdk';
import { getAddress, keccak256, type PublicClient } from 'viem';
import { registry } from './chain';
import approved from './approved-config-a.json';

const owner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const receiptHash = '0xfba851bee3f9ae905b3cefd95fdf197028861ead1ac57a5299b7a74d4880c630';
const configHash = '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862';
const calldataHash = '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309';
const stringify = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);

export async function attestConfigA(client: PublicClient, blockNumber: bigint) {
  if (await client.getChainId() !== 91342) throw new Error('Config A requires GIWA Sepolia');
  const [receipt, transaction] = await Promise.all([
    client.getTransactionReceipt({ hash: receiptHash }),
    client.getTransaction({ hash: receiptHash }),
  ]);
  if (receipt.status !== 'success' || receipt.blockNumber !== 41804688n || blockNumber - receipt.blockNumber + 1n < 12n) throw new Error('Config A receipt is not final and successful');
  const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (canonical.hash !== receipt.blockHash || getAddress(transaction.from) !== owner || !transaction.to || getAddress(transaction.to) !== getAddress(registry) || transaction.value !== 0n || keccak256(transaction.input) !== calldataHash) throw new Error('Config A transaction identity changed');
  const event = parseAmmoraV4ConfigCreatedReceipt(receipt, registry);
  if (event.configId !== 63n || event.configHash.toLowerCase() !== configHash || getAddress(event.owner) !== owner || getAddress(event.feeClaimer) !== owner) throw new Error('Config A event mismatch');
  const snapshot = await getAmmoraV4ConfigAtBlock(client, registry, 63n, blockNumber);
  if (!snapshot.enabled || getAddress(snapshot.identity.owner) !== owner || snapshot.configHash.toLowerCase() !== configHash || stringify(snapshot.config) !== stringify(approved.config) || stringify(snapshot.segments) !== stringify(approved.curve)) throw new Error('Config A owner, policy or curve readback mismatch');
  return snapshot;
}
