import { getAddress, isAddress, type Address } from 'viem';

export function assertLaunchBinding(input: {
  chainId: number;
  expectedCreator?: string;
  expectedURI?: string;
  factory: Address;
  transactionFrom: Address;
  transactionTo: Address | null;
  receiptTo: Address | null;
  eventCreator: Address;
  eventURI: string;
  token: Address;
}): void {
  if (input.chainId !== 91342) throw new Error('Wrong receipt network');
  if (!input.expectedCreator || !isAddress(input.expectedCreator) ||
      getAddress(input.expectedCreator) !== getAddress(input.transactionFrom) ||
      getAddress(input.expectedCreator) !== getAddress(input.eventCreator)) throw new Error('Launch creator does not own metadata');
  if (!input.expectedURI || input.eventURI !== input.expectedURI) throw new Error('Launch metadata URI mismatch');
  if (!input.transactionTo || getAddress(input.transactionTo) !== getAddress(input.factory) ||
      !input.receiptTo || getAddress(input.receiptTo) !== getAddress(input.factory)) throw new Error('Launch target is not the reviewed Factory');
  if (!isAddress(input.token) || getAddress(input.token) === '0x0000000000000000000000000000000000000000') throw new Error('Invalid launched token');
}
