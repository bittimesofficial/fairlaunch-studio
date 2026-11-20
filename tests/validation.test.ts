import { describe, expect, it } from 'vitest';
import { metadataSchema } from '../src/lib/validation';
import { assertPlan } from '../src/lib/browser';

const target = '0x35353a2Dab7426EcCAe6f5FB267702a542ab68fA';
const base = { name: 'Aurora', symbol: 'AURA', description: 'A community token', category: 'Meme & Community', website: 'https://example.org', x: '', telegram: '', discord: '' };
describe('metadata validation', () => {
  it('accepts bounded metadata', () => expect(metadataSchema.safeParse(base).success).toBe(true));
  it('rejects javascript URLs and oversized descriptions', () => {
    expect(metadataSchema.safeParse({ ...base, website: 'javascript:alert(1)' }).success).toBe(false);
    expect(metadataSchema.safeParse({ ...base, description: 'x'.repeat(281) }).success).toBe(false);
  });
  it('rejects arbitrary image types', () => expect(metadataSchema.safeParse({ ...base, image: 'data:image/svg+xml;base64,PHN2Zz4=' }).success).toBe(false));
});
describe('transaction target guard', () => {
  it('requires reviewed target and calldata', () => {
    expect(() => assertPlan({ to: target, data: '0x12345678' }, [target])).not.toThrow();
    expect(() => assertPlan({ to: '0x000000000000000000000000000000000000dEaD', data: '0x12345678' }, [target])).toThrow();
    expect(() => assertPlan({ to: target, data: '0x' }, [target])).toThrow();
  });
});
