import { test, expect } from '@playwright/test';

test('desktop navigation and create wizard', async ({ page }) => {
  await page.goto('/discover');
  await expect(page.getByRole('heading', { name: /Launch ideas/ })).toBeVisible();
  await page.getByRole('link', { name: 'Create Token' }).click();
  await expect(page.getByRole('heading', { name: 'Bring your token to life.' })).toBeVisible();
  await page.getByPlaceholder('e.g. Aurora').fill('Aurora');
  await page.getByPlaceholder('AURA').fill('AURA');
  await page.getByRole('button', { name: /Continue to launch setup/ }).click();
  await expect(page.getByRole('heading', { name: 'Launch setup' })).toBeVisible();
  await expect(page.getByText('Optional first buy (quote asset)')).toBeVisible();
});
test('mobile navigation stays usable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/discover');
  await expect(page.getByRole('link', { name: 'Portfolio' })).toBeVisible();
  await page.getByRole('link', { name: 'Portfolio' }).click();
  await expect(page.getByRole('heading', { name: 'Your portfolio' })).toBeVisible();
});
test('metadata persists across reload and rejects unsafe URL', async ({ page, request }) => {
  await page.goto('/create');
  const payload = { name: 'Persisted token', symbol: 'PERSIST', description: 'Test metadata', category: 'Product & Utility', website: 'https://example.org', x: '', telegram: '', discord: '', creator: '0x000000000000000000000000000000000000dEaD' };
  const created = await request.post('/api/metadata', { data: payload });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.reload();
  const stored = await request.get(`/api/metadata/${id}`);
  expect(stored.status()).toBe(200);
  expect((await stored.json()).name).toBe(payload.name);
  const rejected = await request.post('/api/metadata', { data: { ...payload, website: 'javascript:alert(1)' } });
  expect(rejected.status()).toBe(400);
});
test('wallet connect, wrong network and local disconnect', async ({ page }) => {
  await page.addInitScript(() => {
    window.ethereum = {
      request: async ({ method }) => {
        if (method === 'eth_requestAccounts') return ['0x000000000000000000000000000000000000dEaD'];
        if (method === 'eth_accounts') return [];
        if (method === 'eth_chainId') return '0x1';
        throw new Error(`Unexpected ${method}`);
      },
    };
  });
  await page.goto('/discover');
  await page.getByRole('button', { name: 'Connect Wallet' }).click();
  await expect(page.getByRole('button', { name: /0x0000/ })).toBeVisible();
  await page.getByRole('button', { name: /0x0000/ }).click();
  await expect(page.getByRole('button', { name: 'Connect Wallet' })).toBeVisible();
});
test('invalid wizard details do not advance', async ({ page }) => {
  await page.goto('/create');
  await page.getByRole('button', { name: /Continue to launch setup/ }).click();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText('Enter a name');
  await expect(page.getByRole('heading', { name: 'Token details' })).toBeVisible();
});
