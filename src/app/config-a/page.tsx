'use client';

import { useEffect, useRef, useState } from 'react';
import { formatEther, getAddress, keccak256, type Hex } from 'viem';
import { checkNetwork, connectedAccount, provider, wallet } from '@/lib/browser';
import { chain, explorer } from '@/lib/chain';

type Review = {
  status: string; asOfBlock: string; chainId: number; from: `0x${string}`; to: `0x${string}`; valueWei: string;
  selector: string; calldataHash: Hex; configHash: Hex; data: Hex; nonce: number; gasEstimate: string; gasLimit: string;
  maxFeePerGas: string; maxPriorityFeePerGas: string; unsignedBytes: string; l1FeeWei: string; l1UpperBoundWei: string;
  operatorFeeWei: string; executionCapWei: string; reserveWei: string; spendingCeilingWei: string; balanceWei: string;
  recipients: Record<string, string>; warning: string;
};
const expected = {
  from: '0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5',
  to: '0x6d043014972b87406C4757a5f2d655A24e0b0aF9',
  configHash: '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862',
  calldataHash: '0xbae59b33e23aa03c4cc7ad32d3cdbf724afb099ab82a1b5e8db09110201b6309',
};
const marker = 'fairlaunch-config-a-one-send-status';
const historyKey = 'fairlaunch-config-a-attempt-history';
type Attempt = { state: 'WALLET_REQUEST_OPEN' | 'OUTCOME_UNKNOWN' | 'REJECTED_BY_WALLET' | 'HASH_RETURNED' | 'CANCELLED_RECOVERED'; at: string; nonce: number; calldataHash: string; hash?: string; reason?: string };
function readAttempt(): Attempt | null {
  const raw = localStorage.getItem(marker);
  if (!raw) return null;
  const item = JSON.parse(raw) as Attempt;
  if (!['WALLET_REQUEST_OPEN', 'OUTCOME_UNKNOWN', 'REJECTED_BY_WALLET', 'HASH_RETURNED', 'CANCELLED_RECOVERED'].includes(item.state) || item.calldataHash !== expected.calldataHash || !Number.isSafeInteger(item.nonce)) throw new Error('Invalid local attempt journal; stop and inspect it');
  return item;
}
function writeAttempt(next: Attempt): void {
  const previous = readAttempt();
  if (previous) {
    const history = JSON.parse(localStorage.getItem(historyKey) ?? '[]') as Attempt[];
    if (!Array.isArray(history)) throw new Error('Invalid attempt history; stop');
    history.push(previous);
    localStorage.setItem(historyKey, JSON.stringify(history));
  }
  localStorage.setItem(marker, JSON.stringify(next));
}
function legacyUnknownWithoutSendEvidence(item: Attempt): boolean {
  if (item.state !== 'OUTCOME_UNKNOWN' || item.hash || item.nonce !== 624) return false;
  const history = JSON.parse(localStorage.getItem(historyKey) ?? '[]') as Attempt[];
  if (!Array.isArray(history)) throw new Error('Invalid attempt history; recovery blocked');
  // The old page wrote OUTCOME_UNKNOWN before opening MetaMask. Newer timeout
  // records have a WALLET_REQUEST_OPEN predecessor and must stay blocked.
  return !history.some(entry => entry.nonce === item.nonce && entry.calldataHash === item.calldataHash && (entry.state === 'WALLET_REQUEST_OPEN' || entry.state === 'HASH_RETURNED' || !!entry.hash));
}
function isWalletRejection(error: unknown): boolean {
  let item = error as { code?: number | string; name?: string; cause?: unknown } | null;
  for (let depth = 0; item && depth < 8; depth++) {
    if (item.code === 4001 || item.code === 'ACTION_REJECTED' || item.name === 'UserRejectedRequestError') return true;
    item = item.cause as typeof item;
  }
  return false;
}
const ceilingWei = 300_000_000_000_000n;
const eth = (wei: string) => `${formatEther(BigInt(wei))} ETH`;
function assertReview(result: Review): void {
  if (result.status !== 'REVIEW_ONLY' || result.chainId !== 91342 || result.from !== expected.from || result.to !== expected.to || result.valueWei !== '0' || result.selector !== '0x99da4ed4' || result.configHash !== expected.configHash || result.calldataHash !== expected.calldataHash || keccak256(result.data) !== expected.calldataHash || Object.keys(result.recipients).sort().join(',') !== 'configOwner,leftoverReceiver,partnerFeeRecipient,partnerLpOwner' || Object.values(result.recipients).some(address => address !== expected.from)) throw new Error('Transaction identity changed');
  const gasEstimate = BigInt(result.gasEstimate);
  const gasLimit = BigInt(result.gasLimit);
  const maxFee = BigInt(result.maxFeePerGas);
  const priorityFee = BigInt(result.maxPriorityFeePerGas);
  const l1Fee = BigInt(result.l1FeeWei);
  const l1Upper = BigInt(result.l1UpperBoundWei);
  const operatorFee = BigInt(result.operatorFeeWei);
  const reserve = BigInt(result.reserveWei);
  if (!Number.isSafeInteger(result.nonce) || result.nonce < 0 || gasEstimate <= 0n || gasLimit < gasEstimate || maxFee <= 0n || priorityFee < 0n || priorityFee > maxFee || l1Fee < 0n || l1Upper < l1Fee || operatorFee < 0n || BigInt(result.executionCapWei) !== gasLimit * maxFee || reserve !== gasLimit * maxFee + l1Upper + operatorFee || BigInt(result.spendingCeilingWei) !== ceilingWei || reserve > ceilingWei || BigInt(result.balanceWei) < reserve) throw new Error('Fresh fee, gas or balance guard failed');
}
async function loadReview(): Promise<Review> {
  const response = await fetch('/api/config-a-preflight', { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Preflight blocked');
  assertReview(result as Review);
  return result as Review;
}
const identityKey = (r: Review) => JSON.stringify([r.from, r.to, r.chainId, r.valueWei, r.selector, r.data, r.calldataHash, r.configHash, r.recipients]);
const executionKey = (r: Review) => JSON.stringify([r.gasLimit, r.maxFeePerGas, r.maxPriorityFeePerGas]);

export default function ConfigAPage() {
  const preparing = useRef(false);
  const [account, setAccount] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [hash, setHash] = useState<string | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [cancelAttested, setCancelAttested] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [inspection, setInspection] = useState<{ status: string; reason?: string; transactionHash?: string; configId?: string } | null>(null);

  useEffect(() => {
    try { setAttempt(readAttempt()); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }, []);

  async function connect() {
    try {
      await checkNetwork();
      const selected = await connectedAccount();
      if (getAddress(selected) !== expected.from) throw new Error('Connect the approved owner EOA');
      setAccount(selected);
      setReview(null);
      setAccepted(false);
      setMessage('Кошелёк подключён. Запустите свежую проверку.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  }

  async function preflight() {
    setBusy(true);
    setAccepted(false);
    setReview(null);
    try {
      const prior = readAttempt();
      setAttempt(prior);
      if (prior && prior.state !== 'CANCELLED_RECOVERED') throw new Error('Предыдущая попытка имеет неизвестный или отправленный результат. Сначала проверьте историю кошелька и сеть.');
      await checkNetwork();
      const accounts = await provider().request({ method: 'eth_accounts' }) as string[];
      if (!accounts.some(item => item.toLowerCase() === expected.from.toLowerCase())) throw new Error('Owner account is no longer connected');
      const result = await loadReview();
      setReview(result);
      setMessage('Параметры готовы к проверке владельцем. Открытие страницы и preflight не отправляют транзакцию.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function prepare() {
    if (!review || !accepted || !account || preparing.current) return;
    preparing.current = true;
    setBusy(true);
    try {
      const prior = readAttempt();
      if (prior && prior.state !== 'CANCELLED_RECOVERED') throw new Error('Повторная отправка заблокирована: сначала проверьте предыдущую попытку.');
      await checkNetwork();
      const accounts = await provider().request({ method: 'eth_accounts' }) as string[];
      if (!accounts.some(item => item.toLowerCase() === expected.from.toLowerCase())) throw new Error('Wallet owner changed');
      const fresh = await loadReview();
      if (identityKey(fresh) !== identityKey(review)) throw new Error('Config A identity changed; transaction blocked');
      if (fresh.nonce !== review.nonce) throw new Error('Owner nonce changed; transaction blocked');
      if (executionKey(fresh) !== executionKey(review)) {
        setReview(fresh);
        setAccepted(false);
        throw new Error('Gas limit or EIP-1559 fee caps changed. Review the refreshed values and approve again.');
      }
      // L1 fee, same-state upper bound, balance and block can move. Both snapshots have passed the ceiling and balance guards.
      await checkNetwork();
      const finalAccounts = await provider().request({ method: 'eth_accounts' }) as string[];
      if (!finalAccounts.some(item => item.toLowerCase() === expected.from.toLowerCase())) throw new Error('Wallet owner changed');
      const finalPrior = readAttempt();
      if (finalPrior && finalPrior.state !== 'CANCELLED_RECOVERED') throw new Error('Предыдущая попытка уже отмечена; повторная отправка заблокирована.');
      const opened: Attempt = { state: 'WALLET_REQUEST_OPEN', at: new Date().toISOString(), nonce: fresh.nonce, calldataHash: fresh.calldataHash };
      writeAttempt(opened);
      setAttempt(opened);
      // This is the sole wallet prompt. The owner must click Confirm in the wallet; no automatic retry.
      const txHash = await wallet().sendTransaction({ account: expected.from as `0x${string}`, chain, to: expected.to as `0x${string}`, data: fresh.data, value: 0n, gas: BigInt(fresh.gasLimit), maxFeePerGas: BigInt(fresh.maxFeePerGas), maxPriorityFeePerGas: BigInt(fresh.maxPriorityFeePerGas), nonce: fresh.nonce });
      const returned: Attempt = { state: 'HASH_RETURNED', hash: txHash, at: new Date().toISOString(), nonce: fresh.nonce, calldataHash: fresh.calldataHash };
      writeAttempt(returned);
      setAttempt(returned);
      setHash(txHash);
      setReview(null);
      setMessage('Кошелёк вернул hash. Проверяйте публичный receipt и 12 подтверждений; повторная отправка заблокирована.');
    } catch (error) {
      const rejected = isWalletRejection(error);
      if (rejected) {
        try {
          const prior = readAttempt();
          if (prior?.state === 'WALLET_REQUEST_OPEN') {
            const item: Attempt = { ...prior, state: 'REJECTED_BY_WALLET', reason: 'EIP-1193 user rejection', at: new Date().toISOString() };
            writeAttempt(item);
            setAttempt(item);
          }
        } catch { /* Preserve the unknown marker and block recovery if journal write fails. */ }
      }
      if (!rejected) {
        try {
          const prior = readAttempt();
          if (prior?.state === 'WALLET_REQUEST_OPEN') {
            const unknown: Attempt = { ...prior, state: 'OUTCOME_UNKNOWN', at: new Date().toISOString(), reason: 'Wallet request ended without a hash or explicit rejection' };
            writeAttempt(unknown);
            setAttempt(unknown);
          }
        } catch { /* Keep the open marker as a blocking record. */ }
      }
      setMessage(rejected ? 'Кошелёк отклонил запрос. История сохранена; для новой попытки нужна явная сверка.' : `${error instanceof Error ? error.message : String(error)} Если кошелёк открывался, исход может быть неизвестен: не повторяйте отправку.`);
    } finally { preparing.current = false; setBusy(false); }
  }

  async function reconcileRejected() {
    if (!attempt || !cancelAttested || !recoveryReady || preparing.current) return;
    preparing.current = true;
    setBusy(true);
    try {
      await checkNetwork();
      const accounts = await provider().request({ method: 'eth_accounts' }) as string[];
      if (!accounts.some(item => item.toLowerCase() === expected.from.toLowerCase())) throw new Error('Owner account changed');
      const latest = await provider().request({ method: 'eth_getTransactionCount', params: [expected.from, 'latest'] }) as string;
      const pending = await provider().request({ method: 'eth_getTransactionCount', params: [expected.from, 'pending'] }) as string;
      if (BigInt(latest) < BigInt(attempt.nonce) || BigInt(pending) !== BigInt(latest)) throw new Error('Wallet pending nonce differs from confirmed nonce; recovery blocked');
      const response = await fetch('/api/config-a-reconcile', { cache: 'no-store' });
      const result = await response.json();
      const liveAttempt = readAttempt();
      if (!response.ok || result.chainId !== 91342 || result.owner !== expected.from || result.registry !== expected.to || result.status !== 'NO_CONFIG_A_SEND_EVIDENCE' || result.nextConfigId !== '63' || !Array.isArray(result.matchingEvents) || result.matchingEvents.length !== 0 || !Array.isArray(result.nonceTransactions) || result.latestNonce !== Number(BigInt(latest)) || result.pendingNonce !== Number(BigInt(pending)) || !liveAttempt || liveAttempt.state !== attempt.state || liveAttempt.at !== attempt.at || liveAttempt.nonce !== attempt.nonce || liveAttempt.calldataHash !== attempt.calldataHash || liveAttempt.hash || (attempt.state !== 'REJECTED_BY_WALLET' && !legacyUnknownWithoutSendEvidence(liveAttempt))) throw new Error(result.reason || 'Attempt, wallet or Registry state changed; recovery blocked');
      const recovered: Attempt = { ...attempt, state: 'CANCELLED_RECOVERED', at: new Date().toISOString(), reason: attempt.state === 'REJECTED_BY_WALLET' ? 'Owner-confirmed wallet rejection and read-only reconciliation' : 'Owner attested no Confirm on legacy pre-send marker; wallet and public reconciliation found no send evidence' };
      writeAttempt(recovered);
      setAttempt(recovered);
      setCancelAttested(false);
      setRecoveryReady(false);
      setReview(null);
      setAccepted(false);
      setMessage('Отмена сверена. История сохранена. Запустите новый preflight и вручную проверьте параметры.');
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { preparing.current = false; setBusy(false); }
  }

  async function inspectAttempt() {
    if (preparing.current) return;
    preparing.current = true;
    setBusy(true);
    setRecoveryReady(false);
    setInspection(null);
    try {
      const current = readAttempt();
      setAttempt(current);
      if (!current) throw new Error('Локальная попытка не найдена. Запустите свежий preflight.');
      await checkNetwork();
      const selected = await connectedAccount();
      if (selected !== expected.from) throw new Error('Подключён другой кошелёк; восстановление остановлено.');
      setAccount(selected);
      const walletLatest = BigInt(await provider().request({ method: 'eth_getTransactionCount', params: [expected.from, 'latest'] }) as string);
      const walletPending = BigInt(await provider().request({ method: 'eth_getTransactionCount', params: [expected.from, 'pending'] }) as string);
      const suffix = current.hash ? `?hash=${encodeURIComponent(current.hash)}` : '';
      const response = await fetch(`/api/config-a-reconcile${suffix}`, { cache: 'no-store' });
      const result = await response.json();
      setInspection(result);
      if (!response.ok || result.chainId !== 91342 || result.owner !== expected.from || result.registry !== expected.to) throw new Error(result.reason || 'Публичная сверка недоступна. Повтор запрещён.');
      if (result.status === 'CONFIRMED_CONFIG_A') { setMessage(`Config A уже подтверждён: ID ${result.configId}, hash ${result.transactionHash}. Повтор запрещён.`); return; }
      if (current.hash) { setMessage(`Для сохранённого hash нет подтверждённого Config A: ${result.status}. Повтор запрещён; дождитесь receipt или проверьте его.`); return; }
      if (result.status !== 'NO_CONFIG_A_SEND_EVIDENCE' || !Array.isArray(result.nonceTransactions)) throw new Error(result.reason || `Registry/цепочка изменились: ${result.status}. Повтор запрещён.`);
      if (walletLatest < BigInt(current.nonce) || walletPending !== walletLatest || result.latestNonce !== Number(walletLatest) || result.pendingNonce !== Number(walletPending)) throw new Error('Nonce кошелька и публичной сети расходится или есть pending транзакция. Повтор запрещён.');
      if (result.nextConfigId !== '63' || !Array.isArray(result.matchingEvents) || result.matchingEvents.length !== 0) throw new Error('Registry изменился или найдена запись Config A. Повтор запрещён.');
      if (current.state !== 'REJECTED_BY_WALLET' && !legacyUnknownWithoutSendEvidence(current)) {
        setMessage('Локальная история не подтверждает старый запрос без отправки или содержит более поздний запрос. Возможна pending транзакция; повтор заблокирован.');
        return;
      }
      setRecoveryReady(true);
      setMessage(current.state === 'REJECTED_BY_WALLET' ? `MetaMask отклонил запрос; текущий nonce ${result.latestNonce}, подтверждённые изменения nonce проверены, Config A не найден. Подтвердите отмену ниже.` : `Старый marker записан до ответа MetaMask. Текущий nonce ${result.latestNonce}; ${result.nonceTransactions.length} последующих подтверждённых транзакций проверены, все к другим контрактам. Registry не содержит Config A, видимой pending транзакции нет. Приватную pending транзакцию одни публичные проверки не исключают. Если вы не нажимали Confirm, подтвердите это ниже.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { preparing.current = false; setBusy(false); }
  }

  return <main className="section" style={{ maxWidth: 900 }}>
    <a className="backLink" href="/">← FairLaunch Studio</a>
    <h1 className="pageTitle">Config A · ручное подтверждение</h1>
    <p className="pageLead">Только Registry.createConfig на GIWA Sepolia. Этот экран не запускает токен и не отправляет ничего при открытии.</p>
    <div className="notice">Лимит для решения владельца: 0.0003 ETH. Он проверяется по текущим оценкам, но не ограничивает будущую L1 fee в протоколе. Перед Confirm проверьте итоговую комиссию в кошельке; при превышении лимита отмените.</div>
    <div className="actions"><button className="button secondary" onClick={connect} disabled={busy}>Подключить owner кошелёк</button><button className="button secondary" onClick={preflight} disabled={!account || busy}>Свежий preflight</button></div>
    {account && <p className="hint mono">Подключён: {account}</p>}
    {message && <p role="status" className="notice">{message}</p>}
    {attempt && attempt.state !== 'CANCELLED_RECOVERED' && <section className="card infoCard" style={{ marginTop: 24 }}>
      <h2>Предыдущий запрос</h2><p className="mono">{attempt.state} · nonce {attempt.nonce} · {attempt.at}</p>
      {attempt.hash && <p className="mono">Hash: <a href={`${explorer}/tx/${attempt.hash}`} target="_blank" rel="noreferrer">{attempt.hash}</a></p>}
      <div className="actions"><button className="button secondary" disabled={busy} onClick={inspectAttempt}>Проверить и восстановить попытку</button></div>
      {inspection && <p className="hint">Результат публичной сверки: {inspection.status}{inspection.configId ? ` · Config ID ${inspection.configId}` : ''}{inspection.transactionHash ? ` · hash ${inspection.transactionHash}` : ''}</p>}
      {(attempt.state === 'OUTCOME_UNKNOWN' || attempt.state === 'WALLET_REQUEST_OPEN') && <p className="notice error">Исход запроса MetaMask неизвестен. Проверка сверит marker, кошелёк, pending nonce и Registry; до завершения восстановления повтор запрещён.</p>}
      {recoveryReady && (attempt.state === 'REJECTED_BY_WALLET' || attempt.state === 'OUTCOME_UNKNOWN') && <><p>{attempt.state === 'REJECTED_BY_WALLET' ? 'Кошелёк вернул явное отклонение; публичная сверка не обнаружила отправки.' : 'Для старой попытки нет ответа кошелька. Ваше подтверждение отсутствия Confirm дополняет сверку; сеть одна не может исключить приватную pending транзакцию.'}</p><label><input type="checkbox" checked={cancelAttested} onChange={event => setCancelAttested(event.target.checked)} /> {attempt.state === 'REJECTED_BY_WALLET' ? 'Я отклонил запрос в MetaMask и не нажимал Confirm.' : 'Я не нажимал Confirm для прежнего запроса MetaMask и не подписывал эту транзакцию в другом окне или устройстве.'}</label><div className="actions"><button className="button secondary" disabled={!cancelAttested || busy} onClick={reconcileRejected}>Подтвердить восстановление</button></div></>}
      {attempt.state === 'HASH_RETURNED' && <p className="notice error">Кошелёк вернул hash. Сначала проверьте публичный receipt; повторная отправка заблокирована.</p>}
    </section>}
    {hash && <p className="mono">Transaction hash: <a href={`${explorer}/tx/${hash}`} target="_blank" rel="noreferrer">{hash}</a></p>}
    {review && <section className="card infoCard" style={{ marginTop: 24 }}>
      <h2>Проверьте каждый параметр</h2>
      <div className="detailsTable">
        {([['from', review.from], ['to', review.to], ['chainId', review.chainId], ['value', `${review.valueWei} wei`], ['selector', review.selector], ['calldata hash', review.calldataHash], ['Config hash', review.configHash], ['nonce', review.nonce], ['gas estimate', review.gasEstimate], ['gas limit', review.gasLimit], ['maxFeePerGas', `${review.maxFeePerGas} wei`], ['maxPriorityFeePerGas', `${review.maxPriorityFeePerGas} wei`], ['L1 fee', eth(review.l1FeeWei)], ['L1 upper bound at block', eth(review.l1UpperBoundWei)], ['execution cap', eth(review.executionCapWei)], ['total planning reserve', eth(review.reserveWei)], ['policy ceiling', eth(review.spendingCeilingWei)], ['owner balance', eth(review.balanceWei)], ['unsigned tx size', `${review.unsignedBytes} bytes`], ['block', review.asOfBlock]] as [string, string | number][]).map(([label, value]) => <div key={label}><span>{label}</span><strong className="mono">{value}</strong></div>)}
      </div>
      <h3>Decoded recipients</h3>
      <div className="detailsTable">{Object.entries(review.recipients).map(([label, value]) => <div key={label}><span>{label}</span><strong className="mono">{value}</strong></div>)}</div>
      <p className="hint">{review.warning} Перед Confirm в MetaMask сверьте from/to, GIWA Sepolia, value 0, gas limit {review.gasLimit}, maxFeePerGas {review.maxFeePerGas} wei, maxPriorityFeePerGas {review.maxPriorityFeePerGas} wei и полный итоговый расход. Если кошелёк изменил параметры или показывает больше 0.0003 ETH, отмените.</p>
      <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 20 }}><input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />Я проверил адреса, calldata hash, лимит комиссии и понимаю, что следующий шаг откроет кошелёк для моего ручного Confirm.</label>
      <button className="button primary" style={{ marginTop: 18 }} disabled={!accepted || busy} onClick={prepare}>Подготовить одну транзакцию в кошельке</button>
    </section>}
  </main>;
}
