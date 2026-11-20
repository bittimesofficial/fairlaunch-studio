import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';

const plan = JSON.parse(readFileSync('fixtures/onchain/owner-preflight-2026-11-20T04-50-37.689Z.json', 'utf8'));
const config = JSON.parse(readFileSync('fixtures/onchain/config-a-live-confirmation-2026-11-20.json', 'utf8')).readback;
const owner = plan.input.owner as string;

test('FLTEST Create flow shows exact read-only Plan B before any wallet send', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ launches: [], nextBlock: '41804688' }) }));
  await page.route('**/api/configs**', async route => { await new Promise(resolve => setTimeout(resolve, 800)); await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ nextConfigId: '64', items: [{ ...config, launchEligible: true, reason: 'Verified Config A' }] }) }); });
  await page.route('**/api/fltest-preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'REVIEW_ONLY', chainId: 91342, asOfBlock: plan.chain.blockNumber, from: owner, to: plan.planB.to, configId: '63', configHash: plan.confirmedConfig.configHash, name: 'FairLaunch Test', symbol: 'FLTEST', metadataURI: plan.input.metadataURI, metadataSha256: plan.metadata.sha256, firstBuy: false, data: plan.planB.data, calldataHash: plan.planB.calldataHash, valueWei: '0', nonce: 634, gasEstimate: '1467034', gasLimit: '1760441', maxFeePerGas: '1000276', maxPriorityFeePerGas: '1000000', l1UpperBoundWei: '0', reserveWei: '1760441000000', balanceWei: plan.ownerState.ethBalance }) }));
  await page.addInitScript(address => {
    (window as typeof window & { sends?: number }).sends = 0;
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_sendTransaction') { (window as typeof window & { sends?: number }).sends!++; throw new Error('Unexpected send'); }
      throw new Error(`Unexpected ${method}`);
    } };
  }, owner);
  await page.goto('/create');
  await page.getByRole('button', { name: 'Use approved FLTEST details' }).click();
  await page.locator('input[type="file"]').setInputFiles({ name: 'preview.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9bN9sAAAAASUVORK5CYII=', 'base64') });
  await page.getByRole('button', { name: /Continue to launch setup/ }).click();
  await expect(page.getByText('Checking confirmed Config A on GIWA Sepolia')).toBeVisible();
  await expect(page.getByText('No graduation-qualified Config is available.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('option', { name: /Config #63/ })).toBeAttached();
  await page.getByRole('combobox', { name: 'Ammora Config' }).selectOption('63');
  await expect(page.getByText('The image is visible only in this local preview.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: /Review launch/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Use approved FLTEST metadata without image' }).click();
  await expect(page.locator('.previewArtwork img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Review launch/ })).toBeEnabled();
  await page.getByRole('button', { name: /Review launch/ }).click();
  await page.getByRole('button', { name: 'Prepare FLTEST review' }).click();
  await expect(page.getByText('FLTEST read-only transaction review', { exact: false })).toBeVisible();
  await expect(page.getByText(plan.planB.calldataHash)).toBeVisible();
  await expect(page.getByRole('button', { name: /Confirm launch in wallet/ })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { sends?: number }).sends)).toBe(0);
});

test('Config A attestation failure keeps Review launch disabled with the exact reason', async ({ page }) => {
  await page.route('**/api/catalog', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ launches: [], nextBlock: '41804688' }) }));
  await page.route('**/api/configs**', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Config A owner, policy or curve readback mismatch' }) }));
  await page.goto('/create');
  await page.getByRole('button', { name: 'Use approved FLTEST details' }).click();
  await page.getByRole('button', { name: /Continue to launch setup/ }).click();
  await expect(page.getByText('Config verification failed: Config A owner, policy or curve readback mismatch')).toBeVisible();
  await expect(page.getByRole('button', { name: /Review launch/ })).toBeDisabled();
  await expect(page.getByRole('option', { name: /Config #63/ })).toHaveCount(0);
});
