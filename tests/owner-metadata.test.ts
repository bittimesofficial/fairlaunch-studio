import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { metadataSchema } from '../src/lib/validation';

describe('approved FLTEST v1 metadata', () => {
  it('matches the approved token identity and application metadata schema', () => {
    const data = JSON.parse(readFileSync('fixtures/metadata/fltest/v1/FLTEST.json', 'utf8'));
    expect(metadataSchema.safeParse(data).success).toBe(true);
    expect(data).toEqual({
      name: 'FairLaunch Test',
      symbol: 'FLTEST',
      description: 'Test token created through FairLaunch Studio using the Ammora SDK on GIWA Sepolia.',
      category: 'RWA & Other',
      chainId: 91342,
    });
    expect(data).not.toHaveProperty('token');
    expect(data).not.toHaveProperty('transactionHash');
  });
});
