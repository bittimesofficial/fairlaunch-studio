import { test, expect } from '@playwright/test';

test('MOCK: new token review stops before wallet send when permanent metadata is unavailable', async ({ page }) => {
  let sends = 0;
  await page.addInitScript(() => {
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return ['0x000000000000000000000000000000000000dEaD'];
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_sendTransaction') { (window as Window & { __sent?: number }).__sent = 1; throw new Error('Unexpected wallet send'); }
      throw new Error(`Unexpected ${method}`);
    } };
  });
  await page.route('**/api/preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ chainId: 91342, checkedContracts: 1 }) }));
  await page.route('**/api/configs?focus=config-a', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ configId: '63', enabled: true, launchEligible: true, configHash: '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862', config: { quoteToken: '0x4200000000000000000000000000000000000006', tokenDecimals: 9, poolCreationFee: '0', migrationQuoteThreshold: '5000000000000000', migrationBaseThreshold: '123502500000000', totalSupply: '1000000000000000000', creatorShareOfNonProtocolBps: 1000 } }] }) }));
  await page.goto('/create');
  await page.locator('input[type=file]').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZVJ8AAAAASUVORK5CYII=', 'base64') });
  await page.getByPlaceholder('e.g. Aurora').fill('New Token');
  await page.getByPlaceholder('AURA').fill('NEW');
  await page.getByRole('button', { name: /Continue to launch setup/ }).click();
  await expect(page.getByRole('heading', { name: 'Launch setup' })).toBeVisible();
  await page.getByRole('button', { name: /Review launch/ }).click();
  await page.getByRole('button', { name: /Confirm launch in wallet/ }).click();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText(/metadata service|not configured|unavailable/i);
  sends = await page.evaluate(() => (window as Window & { __sent?: number }).__sent || 0);
  expect(sends).toBe(0);
});
