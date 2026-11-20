import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const approved = JSON.parse(readFileSync('fixtures/onchain/owner-preflight-2026-11-19T18-10-54.878Z.json', 'utf8'));
const ownerAddress = approved.input.owner as string;
function reviewResponse() {
  return { status: 'REVIEW_ONLY', asOfBlock: '41785178', chainId: 91342, from: ownerAddress, to: approved.planA.to, valueWei: '0', selector: '0x99da4ed4', calldataHash: approved.planA.calldataHash, configHash: approved.planA.simulatedReturn[1], data: approved.planA.data, nonce: 624, gasEstimate: '489825', gasLimit: '587790', maxFeePerGas: '1000333', maxPriorityFeePerGas: '1000000', unsignedBytes: '2261', l1FeeWei: '20000000000000', l1UpperBoundWei: '220000000000000', operatorFeeWei: '0', executionCapWei: '587985734070', reserveWei: '220587985734070', spendingCeilingWei: '300000000000000', balanceWei: '110455461723546432', recipients: { configOwner: ownerAddress, partnerFeeRecipient: ownerAddress, partnerLpOwner: ownerAddress, leftoverReceiver: ownerAddress }, warning: 'review' };
}
async function setupAttemptWallet(page: Page, outcome: 'reject' | 'action-rejected' | 'timeout' | 'hash') {
  await page.route('**/api/config-a-preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reviewResponse()) }));
  await page.route('**/api/config-a-reconcile**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: route.request().url().includes('hash=') ? 'PENDING_OR_UNKNOWN_HASH' : 'NO_CONFIG_A_SEND_EVIDENCE', chainId: 91342, owner: ownerAddress, registry: approved.planA.to, latestNonce: 624, pendingNonce: 624, nextConfigId: '63', matchingEvents: [], nonceTransactions: [] }) }));
  await page.addInitScript(({ address, initialOutcome }) => {
    const state = window as typeof window & { attemptMock?: { sends: number; outcome: string; latestNonce: string; pendingNonce: string } };
    state.attemptMock = { sends: 0, outcome: initialOutcome, latestNonce: '0x270', pendingNonce: '0x270' };
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_getTransactionCount') return params?.[1] === 'pending' ? state.attemptMock!.pendingNonce : state.attemptMock!.latestNonce;
      if (method === 'eth_sendTransaction') {
        state.attemptMock!.sends++;
        if (state.attemptMock!.outcome === 'reject') throw Object.assign(new Error('User rejected'), { code: 4001 });
        if (state.attemptMock!.outcome === 'action-rejected') throw Object.assign(new Error('Action rejected'), { code: 'ACTION_REJECTED' });
        if (state.attemptMock!.outcome === 'timeout') throw new Error('RPC timeout');
        return `0x${'d'.repeat(64)}`;
      }
      throw new Error(`Unexpected ${method}`);
    } };
  }, { address: ownerAddress, initialOutcome: outcome });
  await page.goto('/config-a');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
}

test('Config A page requires account, preflight and explicit review before any wallet send', async ({ page }) => {
  const source = JSON.parse(readFileSync('fixtures/onchain/owner-preflight-2026-11-19T18-10-54.878Z.json', 'utf8'));
  const owner = source.input.owner;
  const review = {
    status: 'REVIEW_ONLY', asOfBlock: '41785178', chainId: 91342, from: owner, to: source.planA.to, valueWei: '0',
    selector: '0x99da4ed4', calldataHash: source.planA.calldataHash, configHash: source.planA.simulatedReturn[1], data: source.planA.data,
    nonce: 624, gasEstimate: '489825', gasLimit: '587790', maxFeePerGas: '1000333', maxPriorityFeePerGas: '1000000',
    unsignedBytes: '2261', l1FeeWei: '20000000000000', l1UpperBoundWei: '220000000000000', operatorFeeWei: '0',
    executionCapWei: '587985734070', reserveWei: '220587985734070', spendingCeilingWei: '300000000000000',
    balanceWei: '110455461723546432', recipients: { configOwner: owner, partnerFeeRecipient: owner, partnerLpOwner: owner, leftoverReceiver: owner }, warning: 'review',
  };
  await page.route('**/api/config-a-preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(review) }));
  await page.addInitScript(address => {
    (window as typeof window & { sendCount?: number }).sendCount = 0;
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_sendTransaction') { (window as typeof window & { sendCount?: number }).sendCount!++; throw new Error('send reached'); }
      throw new Error(`Unexpected ${method}`);
    } };
  }, owner);
  await page.goto('/config-a');
  await expect(page.getByRole('button', { name: 'Свежий preflight' })).toBeDisabled();
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByText(source.planA.calldataHash)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' })).toBeDisabled();
  expect(await page.evaluate(() => (window as typeof window & { sendCount?: number }).sendCount)).toBe(0);
});

test('changed network or account blocks preparation before wallet send', async ({ page }) => {
  await page.route('**/api/config-a-preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(reviewResponse()) }));
  await page.addInitScript(address => {
    const state = window as typeof window & { smoke?: { chain: string; account: string; sends: number } };
    state.smoke = { chain: '0x164ce', account: address, sends: 0 };
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return state.smoke!.chain;
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.smoke!.account];
      if (method === 'eth_sendTransaction') { state.smoke!.sends++; throw new Error('send reached'); }
      throw new Error(`Unexpected ${method}`);
    } };
  }, ownerAddress);
  await page.goto('/config-a');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.evaluate(() => { (window as typeof window & { smoke?: { chain: string } }).smoke!.chain = '0x1'; });
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByRole('status')).toContainText('Switch your wallet');
  await page.evaluate(() => { const s = (window as typeof window & { smoke?: { chain: string; account: string } }).smoke!; s.chain = '0x164ce'; s.account = '0x000000000000000000000000000000000000dEaD'; });
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByRole('status')).toContainText('Wallet owner changed');
  expect(await page.evaluate(() => (window as typeof window & { smoke?: { sends: number } }).smoke!.sends)).toBe(0);
});

test('changed execution caps require renewed review, fee ceiling blocks, and rapid double click sends once', async ({ page }) => {
  let calls = 0;
  let mode: 'stale' | 'blocked' | 'ready' = 'stale';
  await page.route('**/api/config-a-preflight', route => {
    calls++;
    if (mode === 'blocked') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ status: 'BLOCKED', error: 'Fee reserve exceeds policy ceiling or balance' }) });
    const data = reviewResponse();
    if (mode === 'stale' && calls > 1) {
      data.maxFeePerGas = '1000334';
      data.executionCapWei = (587790n * 1000334n).toString();
      data.reserveWei = (587790n * 1000334n + 220000000000000n).toString();
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(address => {
    const state = window as typeof window & { smokeSends?: number };
    state.smokeSends = 0;
    window.ethereum = { request: async ({ method }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_sendTransaction') { state.smokeSends!++; return `0x${'a'.repeat(64)}`; }
      throw new Error(`Unexpected ${method}`);
    } };
  }, ownerAddress);
  await page.goto('/config-a');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByRole('status')).toContainText('Gas limit or EIP-1559 fee caps changed');
  expect(await page.evaluate(() => (window as typeof window & { smokeSends?: number }).smokeSends)).toBe(0);
  mode = 'blocked';
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('status')).toContainText('Fee reserve exceeds policy ceiling');
  await expect(page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' })).toHaveCount(0);
  mode = 'ready';
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByText('Transaction hash:')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { smokeSends?: number }).smokeSends)).toBe(1);
});

test('L1 fee and reserve movement below ceiling permits one mock wallet request with fresh parameters', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/config-a-preflight', route => {
    calls++;
    const data = reviewResponse();
    if (calls > 1) {
      data.asOfBlock = '41785179';
      data.l1FeeWei = '23000000000000';
      data.l1UpperBoundWei = '230000000000000';
      data.reserveWei = (587985734070n + 230000000000000n).toString();
      data.balanceWei = '110455461723546400';
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(address => {
    const state = window as typeof window & { sentRequests?: unknown[] };
    state.sentRequests = [];
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_sendTransaction') { state.sentRequests!.push(params); return `0x${'b'.repeat(64)}`; }
      throw new Error(`Unexpected ${method}`);
    } };
  }, ownerAddress);
  await page.goto('/config-a');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByText('Transaction hash:')).toBeVisible();
  const requests = await page.evaluate(() => (window as typeof window & { sentRequests?: unknown[] }).sentRequests);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests![0]).toLowerCase()).toContain(ownerAddress.toLowerCase());
});

test('changed execution fee cap is shown for renewed approval and fresh cap is sent', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/config-a-preflight', route => {
    calls++;
    const data = reviewResponse();
    if (calls > 1) {
      data.maxFeePerGas = '1000400';
      data.executionCapWei = (587790n * 1000400n).toString();
      data.reserveWei = (587790n * 1000400n + 220000000000000n).toString();
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(address => {
    const state = window as typeof window & { sentRequests?: unknown[] };
    state.sentRequests = [];
    window.ethereum = { request: async ({ method, params }) => {
      if (method === 'eth_chainId') return '0x164ce';
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
      if (method === 'eth_sendTransaction') { state.sentRequests!.push(params); return `0x${'c'.repeat(64)}`; }
      throw new Error(`Unexpected ${method}`);
    } };
  }, ownerAddress);
  await page.goto('/config-a');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByRole('status')).toContainText('Gas limit or EIP-1559 fee caps changed');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  expect(await page.evaluate(() => (window as typeof window & { sentRequests?: unknown[] }).sentRequests)).toHaveLength(0);
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByText('Transaction hash:')).toBeVisible();
  const requests = await page.evaluate(() => (window as typeof window & { sentRequests?: unknown[] }).sentRequests);
  expect(requests).toHaveLength(1);
  expect(JSON.stringify(requests![0]).toLowerCase()).toContain(`0x${(1000400).toString(16)}`);
});

for (const [name, mutate, message] of [
  ['nonce', (data: ReturnType<typeof reviewResponse>) => { data.nonce = 625; }, 'Owner nonce changed'],
  ['calldata', (data: ReturnType<typeof reviewResponse>) => { data.data = `${data.data.slice(0, -2)}ff`; }, 'Transaction identity changed'],
  ['fee ceiling', (data: ReturnType<typeof reviewResponse>) => { data.l1UpperBoundWei = '300000000000000'; data.reserveWei = (300000000000000n + 587985734070n).toString(); }, 'Fresh fee, gas or balance guard failed'],
  ['owner', (data: ReturnType<typeof reviewResponse>) => { data.from = '0x000000000000000000000000000000000000dEaD'; }, 'Transaction identity changed'],
  ['chain', (data: ReturnType<typeof reviewResponse>) => { data.chainId = 1; }, 'Transaction identity changed'],
] as const) {
  test(`${name} change blocks before mock wallet request`, async ({ page }) => {
    let calls = 0;
    await page.route('**/api/config-a-preflight', route => {
      calls++;
      const data = reviewResponse();
      if (calls > 1) mutate(data);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
    });
    await page.addInitScript(address => {
      const state = window as typeof window & { sends?: number };
      state.sends = 0;
      window.ethereum = { request: async ({ method }) => {
        if (method === 'eth_chainId') return '0x164ce';
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address];
        if (method === 'eth_sendTransaction') { state.sends!++; throw new Error('Unexpected send'); }
        throw new Error(`Unexpected ${method}`);
      } };
    }, ownerAddress);
    await page.goto('/config-a');
    await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
    await page.getByRole('button', { name: 'Свежий preflight' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
    await expect(page.getByRole('status')).toContainText(message);
    expect(await page.evaluate(() => (window as typeof window & { sends?: number }).sends)).toBe(0);
  });
}

test('cancelled MetaMask request preserves history and needs explicit owner recovery before reopening', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  const first = await page.evaluate(() => ({ marker: JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!), history: JSON.parse(localStorage.getItem('fairlaunch-config-a-attempt-history')!) }));
  expect(first.marker.state).toBe('REJECTED_BY_WALLET');
  expect(first.history.some((item: { state: string }) => item.state === 'WALLET_REQUEST_OPEN')).toBe(true);
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(1);
  await page.reload();
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('MetaMask отклонил запрос');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('status')).toContainText('Предыдущая попытка');
  await page.getByText('Я отклонил запрос в MetaMask').click();
  await page.getByRole('button', { name: 'Подтвердить восстановление' }).click();
  await expect(page.getByRole('status')).toContainText('Отмена сверена');
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!));
  expect(recovered.state).toBe('CANCELLED_RECOVERED');
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('checkbox')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(0);
  await page.evaluate(() => { (window as typeof window & { attemptMock?: { outcome: string } }).attemptMock!.outcome = 'hash'; });
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Подготовить одну транзакцию в кошельке' }).click();
  await expect(page.getByText('Transaction hash:')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(1);
});

test('ACTION_REJECTED is preserved as wallet rejection, not silently cleared', async ({ page }) => {
  await setupAttemptWallet(page, 'action-rejected');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('REJECTED_BY_WALLET');
});

test('pending wallet nonce blocks explicit cancellation recovery', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  await page.evaluate(() => { (window as typeof window & { attemptMock?: { pendingNonce: string } }).attemptMock!.pendingNonce = '0x271'; });
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('Nonce кошелька');
  await expect(page.getByRole('button', { name: 'Подтвердить восстановление' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('REJECTED_BY_WALLET');
});

test('returned hash remains pending and blocks another send after reload', async ({ page }) => {
  await setupAttemptWallet(page, 'hash');
  await expect(page.getByText('HASH_RETURNED', { exact: false })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('сохранённого hash');
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('status')).toContainText('Предыдущая попытка');
  await expect(page.getByRole('button', { name: 'Сверить отмену и разрешить новый preflight' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('HASH_RETURNED');
});

test('timeout leaves unknown outcome blocked across reload', async ({ page }) => {
  await setupAttemptWallet(page, 'timeout');
  await expect(page.getByText('OUTCOME_UNKNOWN', { exact: false })).toBeVisible();
  await page.reload();
  await page.evaluate(() => { const key = 'fairlaunch-config-a-one-send-status'; const item = JSON.parse(localStorage.getItem(key)!); delete item.reason; localStorage.setItem(key, JSON.stringify(item)); });
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(page.getByRole('status')).toContainText('Локальная история не подтверждает старый запрос');
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(0);
  await page.getByRole('button', { name: 'Подключить owner кошелёк' }).click();
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('status')).toContainText('Предыдущая попытка');
  await expect(page.getByRole('button', { name: 'Сверить отмену и разрешить новый preflight' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('OUTCOME_UNKNOWN');
});

test('legacy unknown needs owner no-Confirm attestation and fresh wallet/Registry checks', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    localStorage.setItem('fairlaunch-config-a-one-send-status', JSON.stringify({ state: 'OUTCOME_UNKNOWN', at: '2026-11-19T23:30:00Z', nonce: 624, calldataHash: JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).calldataHash }));
    localStorage.removeItem('fairlaunch-config-a-attempt-history');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('Приватную pending транзакцию одни публичные проверки не исключают');
  await expect(page.getByRole('button', { name: 'Подтвердить восстановление' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /Я не нажимал Confirm/ }).check();
  await page.getByRole('button', { name: 'Подтвердить восстановление' }).click();
  await expect(page.getByRole('status')).toContainText('Отмена сверена');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('CANCELLED_RECOVERED');
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByRole('checkbox')).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(0);
});

test('legacy unknown stays blocked when pending nonce appears before confirmation', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    const key = 'fairlaunch-config-a-one-send-status';
    const item = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ state: 'OUTCOME_UNKNOWN', at: item.at, nonce: 624, calldataHash: item.calldataHash }));
    localStorage.removeItem('fairlaunch-config-a-attempt-history');
  });
  await page.reload();
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await page.getByRole('checkbox', { name: /Я не нажимал Confirm/ }).check();
  await page.evaluate(() => { (window as typeof window & { attemptMock?: { pendingNonce: string } }).attemptMock!.pendingNonce = '0x271'; });
  await page.getByRole('button', { name: 'Подтвердить восстановление' }).click();
  await expect(page.getByRole('status')).toContainText('Wallet pending nonce differs');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('OUTCOME_UNKNOWN');
});

test('confirmed unrelated nonce drift permits legacy recovery and fresh nonce review', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    const key = 'fairlaunch-config-a-one-send-status';
    const item = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ state: 'OUTCOME_UNKNOWN', at: item.at, nonce: 624, calldataHash: item.calldataHash }));
    localStorage.removeItem('fairlaunch-config-a-attempt-history');
  });
  await page.route('**/api/config-a-reconcile**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'NO_CONFIG_A_SEND_EVIDENCE', chainId: 91342, owner: ownerAddress, registry: approved.planA.to, latestNonce: 633, pendingNonce: 633, nextConfigId: '63', matchingEvents: [], nonceTransactions: Array.from({ length: 9 }, (_, i) => ({ nonce: 624 + i, hash: `0x${'a'.repeat(64)}`, to: '0x016e6b1c6e73152ea8c33cda7d960d08608f7c4b' })) }) }));
  await page.route('**/api/config-a-preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...reviewResponse(), nonce: 633 }) }));
  await page.reload();
  await page.evaluate(() => { const mock = (window as typeof window & { attemptMock?: { latestNonce: string; pendingNonce: string } }).attemptMock!; mock.latestNonce = '0x279'; mock.pendingNonce = '0x279'; });
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('9 последующих подтверждённых транзакций проверены');
  await page.getByRole('checkbox', { name: /Я не нажимал Confirm/ }).check();
  await page.getByRole('button', { name: 'Подтвердить восстановление' }).click();
  await expect(page.getByRole('status')).toContainText('Отмена сверена');
  await page.getByRole('button', { name: 'Свежий preflight' }).click();
  await expect(page.getByText('633', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as typeof window & { attemptMock?: { sends: number } }).attemptMock!.sends)).toBe(0);
});

test('unverified nonce history leaves legacy marker blocked with a specific reason', async ({ page }) => {
  await setupAttemptWallet(page, 'reject');
  await expect(page.getByText('REJECTED_BY_WALLET', { exact: false })).toBeVisible();
  await page.evaluate(() => {
    const key = 'fairlaunch-config-a-one-send-status';
    const item = JSON.parse(localStorage.getItem(key)!);
    localStorage.setItem(key, JSON.stringify({ state: 'OUTCOME_UNKNOWN', at: item.at, nonce: 624, calldataHash: item.calldataHash }));
    localStorage.removeItem('fairlaunch-config-a-attempt-history');
  });
  await page.route('**/api/config-a-reconcile**', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'BLOCKED_TX_HISTORY_UNVERIFIED', reason: 'Confirmed owner transaction at nonce 628 not found', chainId: 91342, owner: ownerAddress, registry: approved.planA.to, latestNonce: 633, pendingNonce: 633, nextConfigId: '63', matchingEvents: [] }) }));
  await page.reload();
  await page.evaluate(() => { const mock = (window as typeof window & { attemptMock?: { latestNonce: string; pendingNonce: string } }).attemptMock!; mock.latestNonce = '0x279'; mock.pendingNonce = '0x279'; });
  await page.getByRole('button', { name: 'Проверить и восстановить попытку' }).click();
  await expect(page.getByRole('status')).toContainText('nonce 628 not found');
  await expect(page.getByRole('button', { name: 'Подтвердить восстановление' })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fairlaunch-config-a-one-send-status')!).state)).toBe('OUTCOME_UNKNOWN');
});
