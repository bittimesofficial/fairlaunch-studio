import { getAmmoraV4ConfigAtBlock, getAmmoraV4NextConfigId } from '@ammora-protocol/sdk';
import type { Address, Hex, PublicClient } from 'viem';
import { registry } from './chain';

// A Registry entry being enabled does not prove its graduation policy is safe.
// The known Config #6 identity is explicitly quarantined by Ammora's guide.
export const affectedConfigSixHash: Hex = '0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667';
export type V4Config = Awaited<ReturnType<typeof getAmmoraV4ConfigAtBlock>>;

export function assertReviewedGeneration(chainId: number, address: Address): void {
  if (chainId !== 91342 || address.toLowerCase() !== registry.toLowerCase()) throw new Error('GIWA auto-route V4 Registry required');
}

export function launchPolicyStatus(snapshot: V4Config): { launchEligible: boolean; reason: string } {
  assertReviewedGeneration(91342, registry);
  if (snapshot.configId === 6n && snapshot.configHash.toLowerCase() === affectedConfigSixHash) {
    return { launchEligible: false, reason: 'Config #6 has a documented graduation inventory defect' };
  }
  return { launchEligible: false, reason: 'Graduation policy has not been independently qualified for new launches' };
}

export async function readV4Configs(client: PublicClient, blockNumber: bigint, limit = 10) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid Config page limit');
  assertReviewedGeneration(client.chain?.id ?? 0, registry);
  const nextConfigId = await getAmmoraV4NextConfigId(client, registry, blockNumber);
  const ids = Array.from({ length: Number((nextConfigId - 1n) < BigInt(limit) ? (nextConfigId - 1n) : BigInt(limit)) }, (_, index) => BigInt(index + 1));
  if (nextConfigId > 63n && !ids.includes(63n)) ids.push(63n);
  const items: V4Config[] = [];
  for (const id of ids) {
    if (items.length) await new Promise(resolve => setTimeout(resolve, 600));
    items.push(await getAmmoraV4ConfigAtBlock(client, registry, id, blockNumber));
  }
  return { asOfBlock: blockNumber, nextConfigId, items: items.map(item => ({ ...item, ...launchPolicyStatus(item) })) };
}
