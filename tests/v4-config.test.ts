import { expect, test } from 'vitest';
import { ammoraLaunchConfigRegistryV4Abi, buildCreateAmmoraV4Launch, segmentedALCConfigRegistryV3Abi } from '@ammora-protocol/sdk';
import { assertLaunchPlan } from '../src/lib/launch-plan';
import { affectedConfigSixHash, launchPolicyStatus, type V4Config } from '../src/lib/config';

const fields = (abi: typeof ammoraLaunchConfigRegistryV4Abi | typeof segmentedALCConfigRegistryV3Abi) => {
  const get = abi.find(item => item.type === 'function' && item.name === 'get');
  if (!get) throw new Error('Config getter missing');
  return get.outputs[0].components.map(item => item.name);
};

test('auto-route V4 getter has the on-chain fee layout that the V3 getter lacks', () => {
  expect(fields(ammoraLaunchConfigRegistryV4Abi)[7]).toBe('creatorShareOfNonProtocolBps');
  expect(fields(segmentedALCConfigRegistryV3Abi)[7]).toBe('creatorFeeShareBps');
  expect(fields(segmentedALCConfigRegistryV3Abi).length).toBeGreaterThan(fields(ammoraLaunchConfigRegistryV4Abi).length);
});

test('affected Config #6 stays blocked even when Registry reports enabled', () => {
  const snapshot = { configId: 6n, configHash: affectedConfigSixHash, enabled: true } as V4Config;
  expect(launchPolicyStatus(snapshot)).toEqual({ launchEligible: false, reason: 'Config #6 has a documented graduation inventory defect' });
});

test('ID and hash alone never qualify Config A without receipt/readback attestation', () => {
  const snapshot = { configId: 63n, configHash: '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862', identity: { owner: '0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5' }, enabled: true } as unknown as V4Config;
  expect(launchPolicyStatus(snapshot).launchEligible).toBe(false);
  expect(launchPolicyStatus({ ...snapshot, configHash: affectedConfigSixHash }).launchEligible).toBe(false);
  expect(launchPolicyStatus({ ...snapshot, enabled: false }).launchEligible).toBe(false);
});

test('V4 unsigned launch builder works with local calldata validation without Data API', () => {
  const factory = '0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA';
  const uri = 'https://example.test/metadata/test-only';
  const built = buildCreateAmmoraV4Launch({ name: 'Test only', symbol: 'TST', metadataURI: uri, creatorMetadataURI: uri, tokenDecimals: 9 }, 10n, 0n);
  expect(() => assertLaunchPlan({ to: factory, ...built }, { factory, name: 'Test only', symbol: 'TST', uri, configId: 10n, decimals: 9, fee: 0n })).not.toThrow();
});
