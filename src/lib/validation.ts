import { z } from 'zod';

const url = z.string().max(250).optional().transform(v => v?.trim() || '').refine(v => !v || /^https:\/\/[^\s@]+$/i.test(v), 'Use an HTTPS URL');
export const metadataSchema = z.object({
  name: z.string().trim().min(2).max(60),
  symbol: z.string().trim().regex(/^[A-Za-z0-9]{2,12}$/),
  description: z.string().trim().max(280),
  category: z.enum(['Meme & Community', 'Product & Utility', 'RWA & Other']),
  website: url, x: url, telegram: url, discord: url,
  image: z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).max(2_800_000).optional()
});
export type MetadataInput = z.infer<typeof metadataSchema>;
