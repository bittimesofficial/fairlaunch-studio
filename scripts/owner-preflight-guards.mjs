import { getAddress, isAddress, zeroAddress } from 'viem';

const fixtureAddresses = new Set([
  '0x1111111111111111111111111111111111111111',
  '0x2222222222222222222222222222222222222222',
  '0x3333333333333333333333333333333333333333',
  '0x4444444444444444444444444444444444444444',
  '0x5555555555555555555555555555555555555555',
  '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
]);

export function validateOwnerAddress(value) {
  if (!value || !isAddress(value)) throw new Error('A real public owner address is required');
  const address = getAddress(value);
  if (address === zeroAddress || fixtureAddresses.has(address.toLowerCase())) throw new Error('Fixture or zero owner address is not allowed');
  return address;
}

export function validateMetadataUri(value) {
  if (!value) throw new Error('A permanent HTTPS metadata URI is required');
  let uri;
  try { uri = new URL(value); } catch { throw new Error('Invalid metadata URI'); }
  const host = uri.hostname.toLowerCase();
  if (uri.protocol !== 'https:' || uri.username || uri.password || uri.hash || uri.port ||
      !host.includes('.') || host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.invalid') || host.endsWith('.test') || host.endsWith('.example') ||
      host === 'example.com' || host.endsWith('.example.com') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[')) {
    throw new Error('Metadata must use a public, direct HTTPS hostname');
  }
  return uri.toString();
}

export function requireConfirmedConfigReceipt(phase, hash) {
  if (phase === 'launch' && !/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw new Error('Launch planning requires a confirmed Config creation transaction hash');
}

export function assertOneOwnerRoles(config, configOwner, owner) {
  for (const value of [configOwner, config.partnerRecipient, config.leftoverReceiver, config.liquidityDistribution.partner]) {
    if (getAddress(value) !== owner) throw new Error('Config calldata does not bind every one-owner role');
  }
  const distribution = config.liquidityDistribution;
  if (distribution.partnerUnlockedBps !== 0 || distribution.partnerPermanentLockedBps !== 0 || distribution.partnerVesting.allocationBps !== 0) throw new Error('Config A Partner LP allocation changed');
}
