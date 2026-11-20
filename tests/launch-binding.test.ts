import { expect, test } from 'vitest';
import { assertLaunchBinding } from '../src/lib/launch-binding';

const creator = '0x000000000000000000000000000000000000dEaD';
const stranger = '0x000000000000000000000000000000000000bEEF';
const factory = '0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA';
const valid = { chainId: 91342, expectedCreator: creator, expectedURI: 'https://fairlaunch.example/api/metadata/123', factory, transactionFrom: creator, transactionTo: factory, receiptTo: factory, eventCreator: creator, eventURI: 'https://fairlaunch.example/api/metadata/123', token: '0x0000000000000000000000000000000000001234' } as const;

test('binds only the exact URI, creator and Factory transaction on GIWA Sepolia', () => {
  expect(() => assertLaunchBinding(valid)).not.toThrow();
  expect(() => assertLaunchBinding({ ...valid, eventCreator: stranger })).toThrow('creator');
  expect(() => assertLaunchBinding({ ...valid, transactionFrom: stranger })).toThrow('creator');
  expect(() => assertLaunchBinding({ ...valid, eventURI: `${valid.expectedURI}/other` })).toThrow('URI');
  expect(() => assertLaunchBinding({ ...valid, transactionTo: stranger })).toThrow('Factory');
  expect(() => assertLaunchBinding({ ...valid, chainId: 1 })).toThrow('network');
});
