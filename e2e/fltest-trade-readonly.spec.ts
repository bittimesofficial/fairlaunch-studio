import { expect, test } from '@playwright/test';

const owner = '0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5';
const token = '0x4362c5575918c819122f1A76510130337320cd9C';

test('FLTEST Buy offers verified WETH conversion and live SDK quote without wallet send', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ launches: [{ token, curve: '0xc89805Bd3E5DaF5e0a007Ae5c99474958B32dA8B', creator: owner, configId: '63', metadataURI: 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json', hash: '0xb545d385db7e2962057e0c09e1f2b404efed8d0835eb3ffe0a9cd5b9662efad4', block: '41808502' }], nextBlock: '41808503' }) }));
  await page.addInitScript(address => {
    (window as typeof window & { sends?: number }).sends = 0;
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [address];
      if (method === 'eth_sendTransaction') { (window as typeof window & { sends?: number }).sends!++; throw new Error('Unexpected send'); }
      throw new Error(`Unexpected ${method}`);
    } };
  }, owner);
  await page.goto(`/token/${token}`);
  await expect(page.getByRole('button', { name: 'Wrap ETH → WETH in wallet' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Unwrap WETH → ETH in wallet' })).toBeVisible();
  await page.getByLabel('Amount to spend').fill('0.00001');
  await page.getByRole('button', { name: 'Get live quote' }).click();
  await expect(page.getByText('Minimum received')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Confirm buy in wallet/ })).toBeEnabled();
  expect(await page.evaluate(() => (window as typeof window & { sends?: number }).sends)).toBe(0);
});
