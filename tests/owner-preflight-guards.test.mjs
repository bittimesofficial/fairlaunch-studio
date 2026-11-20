import { describe, expect, it } from 'vitest';
import { assertOneOwnerRoles, requireConfirmedConfigReceipt, validateMetadataUri, validateOwnerAddress } from '../scripts/owner-preflight-guards.mjs';

const owner = '0x7777777777777777777777777777777777777777';

describe('owner preflight safety gates', () => {
  it('requires a real public address and rejects fixture or zero values', () => {
    expect(() => validateOwnerAddress(undefined)).toThrow();
    expect(() => validateOwnerAddress('0x0000000000000000000000000000000000000000')).toThrow();
    expect(() => validateOwnerAddress('0x1111111111111111111111111111111111111111')).toThrow();
    expect(validateOwnerAddress(owner)).toBe(owner);
  });

  it('rejects temporary or local metadata and accepts a public HTTPS shape', () => {
    for (const uri of ['blob:https://site.test/id', 'https://example.invalid/token.json', 'https://localhost/token.json', 'http://metadata.org/token.json', 'https://127.0.0.1/token.json']) {
      expect(() => validateMetadataUri(uri)).toThrow();
    }
    expect(validateMetadataUri('https://metadata.owner.org/token.json')).toBe('https://metadata.owner.org/token.json');
  });

  it('blocks launch planning without a confirmed Config receipt hash', () => {
    expect(() => requireConfirmedConfigReceipt('launch', undefined)).toThrow();
    expect(() => requireConfirmedConfigReceipt('launch', `0x${'a'.repeat(64)}`)).not.toThrow();
  });

  it('requires all one-owner recipient roles and zero Partner LP allocation', () => {
    const config = { partnerRecipient: owner, leftoverReceiver: owner, liquidityDistribution: { partner: owner, partnerUnlockedBps: 0, partnerPermanentLockedBps: 0, partnerVesting: { allocationBps: 0 } } };
    expect(() => assertOneOwnerRoles(config, owner, owner)).not.toThrow();
    expect(() => assertOneOwnerRoles({ ...config, partnerRecipient: '0x8888888888888888888888888888888888888888' }, owner, owner)).toThrow();
    expect(() => assertOneOwnerRoles({ ...config, liquidityDistribution: { ...config.liquidityDistribution, partnerUnlockedBps: 1 } }, owner, owner)).toThrow();
  });
});
