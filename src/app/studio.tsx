'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AmmoraV4LaunchCurveClient, buildCreateAmmoraV4Launch, getAmmoraV4ConfigAtBlock, quoteALCPreLaunchExactInput } from '@ammora-protocol/sdk';
import { erc20Abi, formatUnits, getAddress, isAddress, keccak256, parseUnits, zeroAddress, type Address, type Hex } from 'viem';
import { configClient, deployment, factory, publicClient, registry } from '@/lib/chain';
import { addressLink, assertRuntime, checkNetwork, connectedAccount, execute, limitedApproval, txLink } from '@/lib/browser';
import type { Launch } from '@/lib/catalog';
import { prepareTrade, v4Curve, type TradePlan } from '@/lib/trading';
import { assertLaunchPlan } from '@/lib/launch-plan';
import { retryRead } from '@/lib/rpc-read';
import { metadataSchema } from '@/lib/validation';
import { attestConfigA } from '@/lib/config-a-attestation';
import { giwaWethAddress, wethAbi, wethPlan } from '@/lib/weth';

type Config = { configId: string; enabled: boolean; launchEligible: boolean; reason: string; configHash: Hex; config: { quoteToken: Address; tokenDecimals: number; poolCreationFee: string; migrationQuoteThreshold: string; migrationBaseThreshold: string; totalSupply: string; creatorShareOfNonProtocolBps: number } };
type Metadata = { name: string; symbol: string; description: string; category: string; image: string | null; website: string; x: string; telegram: string; discord: string };
type Activity = { hash: Hex; kind: 'Launch' | 'Buy' | 'Sell' | 'Approval' | 'Wrap' | 'Unwrap'; account: Address; token?: Address; status: 'pending' | 'confirmed' | 'failed' | 'unknown'; at: string };
type FltestReview = { status: 'REVIEW_ONLY'; chainId: number; from: Address; to: Address; configId: string; configHash: Hex; name: string; symbol: string; metadataURI: string; metadataSha256: string; firstBuy: false; data: Hex; calldataHash: Hex; valueWei: string; nonce: number; gasEstimate: string; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; l1UpperBoundWei: string; reserveWei: string; balanceWei: string; asOfBlock: string };
const fltestOwner = getAddress('0x3A0FBb2f36271Ff92ED8a16ca0343a0f320cFCD5');
const fltestUri = 'https://bittimesofficial.github.io/fairlaunch-token-metadata/metadata/v1/FLTEST.json';
const fltestMetadataSha256 = 'c8421af3a27fb87c1d29196a1039783062b1cd2c9da0f467b55be6c8c3a56d2e';
const fltestAttemptKey = 'fairlaunch:fltest-attempt';
const fltestToken = getAddress('0x4362c5575918c819122f1A76510130337320cd9C');
const giwaWeth = giwaWethAddress;
function walletRejected(error: unknown): boolean { let item = error as { code?: number | string; cause?: unknown } | null; for (let depth = 0; item && depth < 8; depth++) { if (item.code === 4001 || item.code === 'ACTION_REJECTED') return true; item = item.cause as typeof item; } return false; }
const empty = { name: '', symbol: '', description: '', category: 'Meme & Community', website: '', x: '', telegram: '', discord: '', image: '' };
const sections = [{ href: '/discover', label: 'Discover' }, { href: '/create', label: 'Create Token' }, { href: '/portfolio', label: 'Portfolio' }, { href: '/activity', label: 'Activity' }];
const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
function niceError(error: unknown) { return error instanceof Error ? error.message : 'Unknown error'; }
function saveActivity(item: Activity) { const all = loadActivity().filter(row => row.hash !== item.hash); localStorage.setItem('fairlaunch:activity', JSON.stringify([item, ...all].slice(0, 100))); window.dispatchEvent(new Event('fairlaunch:activity')); }
function loadActivity(): Activity[] { try { return JSON.parse(localStorage.getItem('fairlaunch:activity') || '[]') as Activity[]; } catch { return []; } }
function walletAttemptKey(account: Address) { return `fairlaunch:trade-wallet-attempt:${account.toLowerCase()}`; }
function pendingWalletAttempt(account: Address) { return localStorage.getItem(walletAttemptKey(account)); }
function beginWalletAttempt(account: Address, kind: Activity['kind']) { localStorage.setItem(walletAttemptKey(account), JSON.stringify({ state: 'WALLET_OPEN', kind, at: new Date().toISOString() })); }
function recordWalletHash(account: Address, hash: Hex) { localStorage.setItem(walletAttemptKey(account), JSON.stringify({ state: 'HASH_RETURNED', hash, at: new Date().toISOString() })); }
function finishWalletAttempt(account: Address) { localStorage.removeItem(walletAttemptKey(account)); }
function settleWalletError(account: Address, error: unknown, walletOpened: boolean, hash?: Hex) {
  if (!walletOpened) return;
  if (!hash && walletRejected(error)) finishWalletAttempt(account);
  else if (!hash) localStorage.setItem(walletAttemptKey(account), JSON.stringify({ state: 'OUTCOME_UNKNOWN', at: new Date().toISOString() }));
}
function external(url: string, label: string) { return /^https:\/\/[^\s@]+$/i.test(url) ? <a href={url} target="_blank" rel="noopener noreferrer">{label} ↗</a> : null; }

export default function Studio({ section = 'discover', tokenAddress }: { section?: string; tokenAddress?: string }) {
  const [account, setAccount] = useState<Address>(); const [network, setNetwork] = useState('Disconnected'); const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [catalog, setCatalog] = useState<Launch[]>([]); const [nextBlock, setNextBlock] = useState(''); const [catalogError, setCatalogError] = useState(''); const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<Activity[]>([]);
  const refresh = useCallback(async () => {
    try { const response = await fetch('/api/catalog', { cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); setCatalog(data.launches || []); setNextBlock(data.nextBlock || ''); setCatalogError(''); }
    catch (error) { setCatalogError(niceError(error)); } finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); setActivity(loadActivity()); const listener = () => setActivity(loadActivity()); window.addEventListener('fairlaunch:activity', listener); const saved = localStorage.getItem('fairlaunch:theme'); if (saved === 'dark') setTheme('dark');
    if (window.ethereum && localStorage.getItem('fairlaunch:disconnected') !== '1') { window.ethereum.request({ method: 'eth_accounts' }).then(value => { const a = value as string[]; if (a?.[0] && isAddress(a[0])) setAccount(getAddress(a[0])); }).catch(() => {}); }
    return () => window.removeEventListener('fairlaunch:activity', listener); }, [refresh]);
  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('fairlaunch:theme', theme); }, [theme]);
  useEffect(() => { if (!account) { setNetwork('Disconnected'); return; } checkNetwork().then(() => setNetwork('GIWA Sepolia')).catch(() => setNetwork('Wrong network')); const onAccounts = (...args: unknown[]) => { const a = args[0] as string[]; setAccount(a?.[0] && isAddress(a[0]) ? getAddress(a[0]) : undefined); }; const onChain = () => checkNetwork().then(() => setNetwork('GIWA Sepolia')).catch(() => setNetwork('Wrong network')); window.ethereum?.on?.('accountsChanged', onAccounts); window.ethereum?.on?.('chainChanged', onChain); return () => { window.ethereum?.removeListener?.('accountsChanged', onAccounts); window.ethereum?.removeListener?.('chainChanged', onChain); }; }, [account]);
  const connect = async () => { try { setAccount(await connectedAccount()); localStorage.removeItem('fairlaunch:disconnected'); } catch (error) { alert(niceError(error)); } };
  const disconnect = () => { localStorage.setItem('fairlaunch:disconnected','1'); setAccount(undefined); };
  const selected = catalog.find(item => item.token.toLowerCase() === tokenAddress?.toLowerCase());
  return <div className="shell"><header className="topbar"><Link className="brand" href="/discover"><span className="brandmark">✦</span><span>FairLaunch <b>Studio</b></span></Link><nav aria-label="Main navigation">{sections.map(item => <Link key={item.href} className={(section === item.href.slice(1) ? 'active' : '')} href={item.href}>{item.label}</Link>)}</nav><div className="headerActions"><span className={'network ' + (network === 'Wrong network' ? 'wrong' : '')}><i />GIWA Sepolia</span><button className="iconButton" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label="Toggle color theme">{theme === 'light' ? '☾' : '☀'}</button>{account ? <button className="walletButton" onClick={disconnect} title="Disconnect wallet locally">{short(account)} <span>×</span></button> : <button className="walletButton" onClick={connect}>Connect Wallet</button>}</div></header>
    <main>{section === 'create' ? <Create account={account} network={network} onConnect={connect} onRefresh={refresh} /> : section === 'portfolio' ? <Portfolio account={account} catalog={catalog} activity={activity} onConnect={connect} /> : section === 'activity' ? <ActivityView account={account} activity={activity} onConnect={connect} /> : section === 'token' ? <TokenPage launch={selected} address={tokenAddress || ''} account={account} catalogError={catalogError} onConnect={connect} /> : <Discover catalog={catalog} nextBlock={nextBlock} loading={loading} error={catalogError} onRetry={refresh} />}</main>
    <footer><span>FairLaunch Studio · Independent GIWA Sepolia builder project</span><span>Powered by Ammora SDK · Testnet only</span></footer></div>;
}

function Discover({ catalog, nextBlock, loading, error, onRetry }: { catalog: Launch[]; nextBlock: string; loading: boolean; error: string; onRetry: () => void }) {
  const [search, setSearch] = useState(''); const [view, setView] = useState<'grid' | 'list'>('grid'); const [page, setPage] = useState(0); const [filter, setFilter] = useState('All'); const [names, setNames] = useState<Record<string,string>>({});
  useEffect(() => { let active = true; Promise.all(catalog.slice(0,200).filter(item => /^https:\/\//.test(item.metadataURI)).map(async item => { try { const response = await fetch(item.metadataURI); const data = response.ok ? await response.json() : null; return [item.token, `${data?.name || ''} ${data?.symbol || ''}`] as const; } catch { return [item.token, ''] as const; } })).then(rows => { if (active) setNames(Object.fromEntries(rows)); }); return () => { active = false; }; }, [catalog]);
  const rows = useMemo(() => catalog.filter(item => { const q = search.toLowerCase(); return (item.token.toLowerCase().includes(q) || item.creator.toLowerCase().includes(q) || item.metadataURI.toLowerCase().includes(q) || (names[item.token] || '').toLowerCase().includes(q)) && (filter === 'All' || filter === 'New'); }).sort((a,b) => Number(BigInt(b.block) - BigInt(a.block))), [catalog, search, filter, names]);
  return <><section className="hero"><div className="eyebrow">THE OPEN LAUNCHPAD · GIWA SEPOLIA</div><h1>Launch ideas.<br/><em>Trade what’s next.</em></h1><p>Create a token, explore on-chain launches and trade with transparent Ammora markets.</p><div className="heroActions"><Link className="button primary" href="/create">Create a token <span>↗</span></Link><a className="button secondary" href="#explore">Explore launches ↓</a></div><div className="orb orbOne"/><div className="orb orbTwo"/></section>
    <section id="explore" className="section"><div className="sectionHeading"><div><div className="eyebrow">DISCOVER</div><h2>Explore launches</h2><p>Confirmed Factory launches since FLTEST. Scan cursor: {nextBlock || 'unavailable'}. Metrics appear when verifiable.</p></div><span className="count">{catalog.length} indexed</span></div><div className="toolbar"><label className="search"><span>⌕</span><input aria-label="Search tokens" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} placeholder="Search address or metadata URI" /></label><div className="segmented"><button className={filter === 'All' ? 'selected' : ''} onClick={() => setFilter('All')}>All</button><button className={filter === 'New' ? 'selected' : ''} onClick={() => setFilter('New')}>New</button></div><div className="segmented"><button aria-label="Grid view" className={view === 'grid' ? 'selected' : ''} onClick={() => setView('grid')}>▦</button><button aria-label="List view" className={view === 'list' ? 'selected' : ''} onClick={() => setView('list')}>☷</button></div></div>
    {error && <div className="notice error">RPC unavailable: {error} <button onClick={onRetry}>Retry</button></div>}{loading ? <div className="tokenGrid">{[1,2,3].map(n => <div key={n} className="skeleton card" />)}</div> : rows.length ? <><div className={view === 'grid' ? 'tokenGrid' : 'tokenList'}>{rows.slice(page * 12, page * 12 + 12).map(row => <TokenCard key={row.token} launch={row} />)}</div><div className="pagination"><button disabled={page === 0} onClick={() => setPage(page - 1)}>← Previous</button><span>Page {page + 1}</span><button disabled={(page + 1) * 12 >= rows.length} onClick={() => setPage(page + 1)}>Next →</button></div></> : <div className="empty"><span className="emptyIcon">✦</span><h3>No verified launches to show yet</h3><p>{nextBlock ? `Indexer scanning from block ${nextBlock}. Refresh to continue.` : 'Connect to GIWA Sepolia RPC to index confirmed launches.'}</p><button className="button secondary" onClick={onRetry}>Refresh catalog</button></div>}</section></>;
}
function TokenCard({ launch }: { launch: Launch }) { const [meta, setMeta] = useState<Metadata>(); useEffect(() => { if (/^https:\/\//.test(launch.metadataURI)) fetch(launch.metadataURI).then(r => r.ok ? r.json() : null).then(setMeta).catch(() => {}); }, [launch.metadataURI]); return <Link className="card tokenCard" href={`/token/${launch.token}`}><div className="tokenTop"><div className="tokenAvatar">{meta?.image ? <img src={meta.image} alt="" /> : '✦'}</div><span className="statusPill">● On-chain</span></div><h3>{meta?.name || short(launch.token)}</h3><div className="muted">{meta?.symbol || short(launch.token)} · {short(launch.token)}</div><div className="cardDivider"/><div className="cardStats"><span>Price<strong>N/A</strong></span><span>Volume<strong>N/A</strong></span><span>Market cap<strong>N/A</strong></span></div><div className="cardFoot">View token <span>↗</span></div></Link>; }

function Create({ account, network, onConnect, onRefresh }: { account?: Address; network: string; onConnect: () => void; onRefresh: () => void }) {
  const launchPaused = false;
  const [step, setStep] = useState(1); const [form, setForm] = useState(empty); const [configs, setConfigs] = useState<Config[]>([]); const [configId, setConfigId] = useState(''); const [configError, setConfigError] = useState(''); const [configLoading, setConfigLoading] = useState(false); const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [success, setSuccess] = useState<{ token: string; hash: string }>(); const [pending, setPending] = useState<{ id: string; hash: Hex; account?: Address }>(); const [balance, setBalance] = useState<string>('N/A'); const [firstBuy, setFirstBuy] = useState(''); const [firstBuySlippage, setFirstBuySlippage] = useState('1'); const [fltestReview, setFltestReview] = useState<FltestReview | null>(null);
  const lock = useRef(false);
  const fltestMode = form.name.trim() === 'FairLaunch Test' && form.symbol.trim() === 'FLTEST';
  useEffect(() => { try { const saved = localStorage.getItem('fairlaunch:pending-launch'); if (saved) setPending(JSON.parse(saved)); } catch { /* ignore */ } }, []);
  useEffect(() => { if (step !== 2) return; let active = true; setConfigLoading(true); setConfigs([]); setConfigId(''); setConfigError(''); fetch('/api/configs?focus=config-a', { cache: 'no-store' }).then(async r => { const data = await r.json(); if (!r.ok) throw new Error(data.error); if (!active) return; const list = (data.items || []).filter((item: Config) => item.enabled && item.launchEligible); setConfigs(list); setConfigId(list[0]?.configId || ''); }).catch(e => { if (active) { setConfigs([]); setConfigId(''); setConfigError(niceError(e)); } }).finally(() => { if (active) setConfigLoading(false); }); return () => { active = false; }; }, [step]);
  useEffect(() => { if (!account) return; publicClient.getBalance({ address: account }).then(value => setBalance(formatUnits(value, 18) + ' ETH')).catch(() => setBalance('N/A')); }, [account]);
  const selected = configs.find(item => item.configId === configId);
  const update = (key: keyof typeof empty, value: string) => { setFltestReview(null); setForm(old => ({ ...old, [key]: value })); };
  const loadFltestReview = async (): Promise<FltestReview> => {
    const response = await fetch('/api/fltest-preflight', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'FLTEST preflight blocked');
    if (data.status !== 'REVIEW_ONLY' || data.chainId !== 91342 || data.from !== fltestOwner || data.to !== factory || data.configId !== '63' || data.configHash !== '0xb8f7c1a7fcd7e2fc15a8402f7354ba1e220d56cffbdf51f14cfeff1758ff9862' || data.metadataURI !== fltestUri || data.metadataSha256 !== fltestMetadataSha256 || data.firstBuy !== false || data.name !== 'FairLaunch Test' || data.symbol !== 'FLTEST' || keccak256(data.data) !== data.calldataHash || BigInt(data.balanceWei) < BigInt(data.reserveWei)) throw new Error('FLTEST plan identity or balance changed');
    return data as FltestReview;
  };
  const prepareFltest = async () => {
    setBusy(true); setError(''); setFltestReview(null);
    try {
      const prior = localStorage.getItem(fltestAttemptKey);
      if (prior && JSON.parse(prior).state !== 'REJECTED_BY_WALLET') throw new Error('Previous FLTEST wallet request has an unresolved outcome. Do not retry.');
      if (!account || account !== fltestOwner) throw new Error('Connect the approved FLTEST owner wallet');
      if (!selected || selected.configId !== '63') throw new Error('Select verified Config #63');
      if (firstBuy.trim()) throw new Error('FLTEST first buy must remain disabled');
      if (form.description !== 'Test token created through FairLaunch Studio using the Ammora SDK on GIWA Sepolia.' || form.category !== 'RWA & Other' || !!form.website || !!form.x || !!form.telegram || !!form.discord) throw new Error('Use approved FLTEST details');
      if (form.image) throw new Error('Remove the preview image; it is absent from the approved permanent metadata');
      await checkNetwork();
      const review = await loadFltestReview();
      setFltestReview(review);
    } catch (error) { setError(niceError(error)); } finally { setBusy(false); }
  };
  const next = () => { if (form.name.trim().length < 2 || !/^[A-Za-z0-9]{2,12}$/.test(form.symbol) || form.description.length > 280) { setError('Enter a name, 2–12 character ticker and a description under 280 characters.'); return; } for (const key of ['website','x','telegram','discord'] as const) if (form[key] && !/^https:\/\/[^\s@]+$/i.test(form[key])) { setError(`${key}: use an HTTPS URL`); return; } setError(''); setConfigLoading(true); setStep(2); };
  const recover = async () => { if (!pending) return; setBusy(true); setError(''); try { const response = await fetch('/api/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending) }); const data = await response.json(); if (response.status === 422 && data.error === 'Transaction reverted') { localStorage.removeItem('fairlaunch:pending-launch'); setPending(undefined); if (pending.account) { finishWalletAttempt(pending.account); saveActivity({ hash: pending.hash, kind: 'Launch', account: pending.account, status: 'failed', at: new Date().toISOString() }); } throw new Error('Launch transaction reverted; no token was created'); } if (!response.ok) throw new Error(data.error); localStorage.removeItem('fairlaunch:pending-launch'); if (pending.id === 'fltest-v1') localStorage.setItem(fltestAttemptKey, JSON.stringify({ state: 'CONFIRMED', hash: pending.hash, token: data.token, at: new Date().toISOString() })); setPending(undefined); setSuccess({ token: data.token, hash: pending.hash }); if (pending.account) { finishWalletAttempt(pending.account); saveActivity({ hash: pending.hash, kind: 'Launch', account: pending.account, token: data.token, status: 'confirmed', at: new Date().toISOString() }); } onRefresh(); } catch (e) { setError(niceError(e)); } finally { setBusy(false); } };
  const launch = async () => {
    if (lock.current || busy) return; lock.current = true; setBusy(true); setError('');
    try {
       if (!account) throw new Error('Connect your wallet'); if (localStorage.getItem('fairlaunch:pending-launch') || (!fltestMode && pendingWalletAttempt(account))) throw new Error('Resolve the previous wallet attempt before sending another launch'); await checkNetwork(); await assertRuntime();
      if (!selected?.enabled || !selected.launchEligible) throw new Error('Choose a graduation-qualified Ammora V4 config');
      if (fltestMode) {
        if (!fltestReview || account !== fltestOwner || selected.configId !== '63' || firstBuy.trim()) throw new Error('Review the exact no-first-buy FLTEST plan before opening the wallet');
        const previousAttempt = localStorage.getItem(fltestAttemptKey);
        if (previousAttempt && JSON.parse(previousAttempt).state !== 'REJECTED_BY_WALLET') throw new Error('Previous FLTEST wallet request has an unresolved outcome. Do not retry.');
        const fresh = await loadFltestReview();
        if (fresh.calldataHash !== fltestReview.calldataHash || fresh.data !== fltestReview.data || fresh.nonce !== fltestReview.nonce || fresh.gasLimit !== fltestReview.gasLimit || fresh.maxFeePerGas !== fltestReview.maxFeePerGas || fresh.maxPriorityFeePerGas !== fltestReview.maxPriorityFeePerGas) { setFltestReview(fresh); throw new Error('FLTEST nonce or fee review changed. Check the refreshed plan and click again.'); }
        setFltestReview(fresh); // L1 upper bound can drift; the fresh server guard still checks balance.
        const plan = { to: factory, data: fresh.data, value: BigInt(fresh.valueWei) };
        assertLaunchPlan(plan, { factory, name: 'FairLaunch Test', symbol: 'FLTEST', uri: fltestUri, configId: 63n, decimals: 9, fee: 0n });
        const hash = await execute(plan, account, [factory], hash => { const item = { id: 'fltest-v1', hash, account }; localStorage.setItem(fltestAttemptKey, JSON.stringify({ state: 'HASH_RETURNED', hash, nonce: fresh.nonce, calldataHash: fresh.calldataHash, at: new Date().toISOString() })); setPending(item); localStorage.setItem('fairlaunch:pending-launch', JSON.stringify(item)); saveActivity({ hash, kind: 'Launch', account, status: 'pending', at: new Date().toISOString() }); }, () => { if (previousAttempt) { const history = JSON.parse(localStorage.getItem('fairlaunch:fltest-attempt-history') || '[]'); if (!Array.isArray(history)) throw new Error('FLTEST attempt history invalid'); history.push(JSON.parse(previousAttempt)); localStorage.setItem('fairlaunch:fltest-attempt-history', JSON.stringify(history)); } localStorage.setItem(fltestAttemptKey, JSON.stringify({ state: 'WALLET_REQUEST_OPEN', nonce: fresh.nonce, calldataHash: fresh.calldataHash, at: new Date().toISOString() })); });
        await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000, confirmations: 12 });
        const confirmation = await fetch('/api/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'fltest-v1', hash }) });
        const result = await confirmation.json(); if (!confirmation.ok) throw new Error(result.error);
        localStorage.removeItem('fairlaunch:pending-launch'); localStorage.setItem(fltestAttemptKey, JSON.stringify({ state: 'CONFIRMED', hash, token: result.token, at: new Date().toISOString() })); setPending(undefined); setSuccess({ token: result.token, hash: result.hash }); saveActivity({ hash: result.hash, kind: 'Launch', account, token: result.token, status: 'confirmed', at: new Date().toISOString() }); onRefresh();
        return;
      }
       const metadataInput = metadataSchema.parse(form);
       if (!metadataInput.image) throw new Error('Choose a PNG, JPEG or WebP image before launch');
       const encoded = new TextEncoder().encode(JSON.stringify(metadataInput));
       const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoded)), byte => byte.toString(16).padStart(2, '0')).join('');
       const challengeResponse = await fetch('/api/metadata/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creator: account, digest }) });
       const challenge = await challengeResponse.json(); if (!challengeResponse.ok) throw new Error(challenge.error);
       const signature = await window.ethereum?.request({ method: 'personal_sign', params: [challenge.message, account] });
       if (typeof signature !== 'string') throw new Error('Wallet signature required for metadata publication');
       await checkNetwork();
       const response = await fetch('/api/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...metadataInput, creator: account, nonce: challenge.nonce, signature }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error);
      const sdk = configClient();
      let plan;
      if (firstBuy.trim()) {
        if (deployment.contracts.launch.protocolVersion === 4) throw new Error('First buy requires a reviewed V4 portable plan; this Config is not qualified yet');
        const live = await sdk.getConfig(BigInt(selected.configId));
        if (!live.enabled || live.config.quoteToken.toLowerCase() !== selected.config.quoteToken.toLowerCase()) throw new Error('Config changed; review launch setup again');
        if (live.config.activationDelay !== 0) throw new Error('First buy requires a Config with immediate activation');
        const quoteDecimals = await publicClient.readContract({ address: live.config.quoteToken, abi: erc20Abi, functionName: 'decimals' });
        const amount = parseUnits(firstBuy, quoteDecimals);
        const slippageBps = Math.round(Number(firstBuySlippage) * 100);
        if (amount <= 0n || !Number.isInteger(slippageBps) || slippageBps < 1 || slippageBps > 1000) throw new Error('Invalid first-buy amount or slippage');
        const quoteBalance = await publicClient.readContract({ address: live.config.quoteToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
        if (quoteBalance < amount) throw new Error('Insufficient quote asset for first buy');
        const head = await publicClient.getBlock();
        const currentPoint = live.config.activationType === 0 ? head.timestamp : head.number;
        const quote = quoteALCPreLaunchExactInput(live.config, live.curve, amount, false, { activationPoint: currentPoint, currentPoint, hasSwap: false, slippageBps });
        if (quote.minimumAmountOut <= 0n || quote.amountLeft !== 0n) throw new Error('First-buy quote has no safe full-fill minimum');
        const firstBuyExecutor = deployment.contracts.launch.firstBuyExecutor;
        if (!firstBuyExecutor) throw new Error('Reviewed first-buy helper unavailable');
        const deadline = BigInt(Math.floor(Date.now()/1000) + 180);
        const prepared = await sdk.planLaunchWithTokenConfigAndBuyWithApproval({ factory, firstBuyExecutor, name: form.name.trim(), symbol: form.symbol.trim(), metadataURI: data.uri, creatorMetadataURI: data.uri, configId: BigInt(selected.configId), tokenDecimals: live.config.tokenDecimals, firstBuys: [{ includedQuoteAmount: amount, minimumBaseAmountOut: quote.minimumAmountOut, allowPartialFill: false, recipient: account, referrer: zeroAddress }], deadline });
         assertLaunchPlan(prepared.transaction, { factory, name: form.name.trim(), symbol: form.symbol.trim(), uri: data.uri, configId: BigInt(selected.configId), decimals: live.config.tokenDecimals, fee: live.config.poolCreationFee, firstBuy: { helper: firstBuyExecutor, amount, minOut: quote.minimumAmountOut, recipient: account, deadline } });
        for (const approval of prepared.approvalRequirements) {
          if (approval.token.toLowerCase() !== live.config.quoteToken.toLowerCase() || approval.spender.toLowerCase() !== firstBuyExecutor.toLowerCase() || approval.amount > amount) throw new Error('Unexpected first-buy approval');
          await limitedApproval(approval.token, approval.spender, approval.amount, account, hash => saveActivity({ hash, kind: 'Approval', account, status: 'pending', at: new Date().toISOString() }));
        }
        plan = prepared.transaction;
      } else {
        const blockNumber = await publicClient.getBlockNumber();
        const live = await getAmmoraV4ConfigAtBlock(publicClient, registry, BigInt(selected.configId), blockNumber);
        if (!live.enabled || live.configHash !== selected.configHash || live.config.quoteToken.toLowerCase() !== selected.config.quoteToken.toLowerCase()) throw new Error('V4 Config changed; review launch setup again');
        if (live.configId !== 63n) throw new Error('Only attested Config #63 is eligible for a new launch');
        const attested = await attestConfigA(publicClient, blockNumber);
        if (attested.configHash !== live.configHash) throw new Error('Config #63 attestation changed');
        const built = buildCreateAmmoraV4Launch({ name: form.name.trim(), symbol: form.symbol.trim(), metadataURI: data.uri, creatorMetadataURI: data.uri, tokenDecimals: live.config.tokenDecimals }, live.configId, live.config.poolCreationFee);
        plan = { to: factory, ...built };
        assertLaunchPlan(plan, { factory, name: form.name.trim(), symbol: form.symbol.trim(), uri: data.uri, configId: live.configId, decimals: live.config.tokenDecimals, fee: live.config.poolCreationFee });
      }
       const hash = await execute(plan, account, [factory], hash => { recordWalletHash(account, hash); const item = { id: data.id, hash, account }; setPending(item); localStorage.setItem('fairlaunch:pending-launch', JSON.stringify(item)); saveActivity({ hash, kind: 'Launch', account, status: 'pending', at: new Date().toISOString() }); }, () => beginWalletAttempt(account, 'Launch'));
      const confirmation = await fetch('/api/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: data.id, hash }) });
      const result = await confirmation.json(); if (!confirmation.ok) throw new Error(result.error);
      localStorage.removeItem('fairlaunch:pending-launch'); finishWalletAttempt(account); setPending(undefined); setSuccess({ token: result.token, hash: result.hash }); saveActivity({ hash: result.hash, kind: 'Launch', account, token: result.token, status: 'confirmed', at: new Date().toISOString() }); onRefresh();
    } catch (e) { if (account && !fltestMode && walletRejected(e)) { try { const marker = JSON.parse(pendingWalletAttempt(account) || 'null'); if (marker?.state === 'WALLET_OPEN') finishWalletAttempt(account); } catch { /* Keep the blocking marker. */ } } if (fltestMode && walletRejected(e)) { try { const prior = JSON.parse(localStorage.getItem(fltestAttemptKey) || 'null'); if (prior?.state === 'WALLET_REQUEST_OPEN') localStorage.setItem(fltestAttemptKey, JSON.stringify({ ...prior, state: 'REJECTED_BY_WALLET', at: new Date().toISOString() })); } catch { /* Keep the blocking marker. */ } } setError(niceError(e)); } finally { lock.current = false; setBusy(false); }
  };
  return <section className="section createSection"><div className="eyebrow">CREATE ON GIWA SEPOLIA</div><h1 className="pageTitle">Bring your token to life.</h1><p className="pageLead">A guided launch with real Ammora configuration and an explicit wallet confirmation.</p>{launchPaused && <div className="notice">FLTEST is already live. New token creation is paused until permanent metadata hosting and policy review are available. <Link href={`/token/${fltestToken}`}>Open FLTEST →</Link></div>}
    {success ? <div className="card successPanel"><span className="successIcon">✓</span><h2>Launch confirmed</h2><p>Your token was found in a successful GIWA Sepolia factory receipt.</p><div className="mono">{success.token}</div><div className="actions"><Link className="button primary" href={`/token/${success.token}`}>View token →</Link><a className="button secondary" href={txLink(success.hash)} target="_blank" rel="noreferrer">View receipt ↗</a></div></div> : <><div className="steps"><span className={step >= 1 ? 'current' : ''}>01 <b>Token details</b></span><span className={step >= 2 ? 'current' : ''}>02 <b>Launch setup</b></span><span className={step >= 3 ? 'current' : ''}>03 <b>Review & launch</b></span></div><div className="createLayout"><div className="card formCard">{step === 1 ? <><h2>Token details</h2><p>Give your community something to recognize.</p><button className="button secondary" onClick={() => { setFltestReview(null); setForm({ ...empty, name: "FairLaunch Test", symbol: "FLTEST", description: "Test token created through FairLaunch Studio using the Ammora SDK on GIWA Sepolia.", category: "RWA & Other" }); }}>Use approved FLTEST details</button><label className="upload">{form.image ? <img src={form.image} alt="Token image preview" /> : <span>＋</span>}<strong>{form.image ? 'Change image' : 'Upload token image'}</strong><small>PNG, JPG or WebP · max 2 MB</small><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e => { const file = e.target.files?.[0]; if (!file) return; if (file.size > 2_000_000 || !['image/png','image/jpeg','image/webp'].includes(file.type)) { setError('Choose a PNG, JPG or WebP under 2 MB'); return; } const reader = new FileReader(); reader.onload = () => update('image', String(reader.result)); reader.readAsDataURL(file); }} /></label><div className="twoCols"><label>Token name *<input value={form.name} maxLength={60} onChange={e => update('name', e.target.value)} placeholder="e.g. Aurora" /></label><label>Ticker *<input value={form.symbol} maxLength={12} onChange={e => update('symbol', e.target.value.toUpperCase())} placeholder="AURA" /></label></div><label>Description <textarea value={form.description} maxLength={280} onChange={e => update('description', e.target.value)} placeholder="Tell people what this token is about" /><small>{form.description.length}/280</small></label><label>Category<select value={form.category} onChange={e => update('category', e.target.value)}><option>Meme & Community</option><option>Product & Utility</option><option>RWA & Other</option></select></label><div className="twoCols">{(['website','x','telegram','discord'] as const).map(key => <label key={key}>{key === 'x' ? 'X' : key[0].toUpperCase() + key.slice(1)}<input type="url" value={form[key]} onChange={e => update(key, e.target.value)} placeholder="https://" /></label>)}</div><button className="button primary wide" onClick={next} disabled={launchPaused}>Continue to launch setup →</button></> : step === 2 ? <><h2>Launch setup</h2><p>These parameters come from enabled Ammora Configs.</p>{configLoading && <div className="notice">Checking confirmed Config A on GIWA Sepolia…</div>}{configError && <div className="notice error">Config verification failed: {configError}</div>}{fltestMode && !!form.image && <div className="notice error">The image is visible only in this local preview. The approved permanent FLTEST metadata has no image, so it will not be published with this token. <button onClick={() => { setFltestReview(null); setForm({ ...empty, name: "FairLaunch Test", symbol: "FLTEST", description: "Test token created through FairLaunch Studio using the Ammora SDK on GIWA Sepolia.", category: "RWA & Other" }); }}>Use approved FLTEST metadata without image</button></div>}<label>Ammora Config<select value={configId} onChange={e => { setFltestReview(null); setConfigId(e.target.value); }}><option value="">Select an enabled config</option>{configs.map(c => <option key={c.configId} value={c.configId}>Config #{c.configId} · {short(c.config.quoteToken)}</option>)}</select></label>{selected ? <div className="detailsTable"><div><span>Quote asset</span><a href={addressLink(selected.config.quoteToken)} target="_blank" rel="noreferrer">{short(selected.config.quoteToken)} ↗</a></div><div><span>Token decimals</span><strong>{selected.config.tokenDecimals}</strong></div><div><span>Creation fee</span><strong>{formatUnits(BigInt(selected.config.poolCreationFee), 18)} ETH</strong></div><div><span>Quote graduation threshold</span><strong>{selected.config.migrationQuoteThreshold} raw</strong></div><div><span>Creator fee share</span><strong>{selected.config.creatorShareOfNonProtocolBps} bps (Config)</strong></div><div><span>Wallet gas balance</span><strong>{balance}</strong></div></div> : !configLoading && !configError ? <div className="notice">No graduation-qualified Config is available. Launch remains unavailable until an operator verifies the full policy.</div> : null}<p className="hint">Gas is estimated from the prepared transaction immediately before wallet confirmation. Optional first buy is prepared from a live Config and SDK pre-launch quote when immediate activation is supported.</p><div className="actions"><button className="button secondary" onClick={() => setStep(1)}>← Back</button><button className="button primary" disabled={!selected || configLoading || (fltestMode && !!form.image)} onClick={() => setStep(3)}>Review launch →</button></div></> : <><h2>Review & launch</h2><p>Check the token and transaction before signing.</p><div className="reviewToken"><div className="tokenAvatar">{form.image ? <img src={form.image} alt="" /> : '✦'}</div><div><h3>{form.name} <span>${form.symbol}</span></h3><p>{form.description || 'No description'}</p></div></div><div className="detailsTable"><div><span>Network</span><strong>GIWA Sepolia · 91342</strong></div><div><span>Factory</span><strong className="mono">{short(factory)}</strong></div><div><span>Config</span><strong>#{configId}</strong></div><div><span>Quote asset</span><strong>{selected ? short(selected.config.quoteToken) : 'N/A'}</strong></div><div><span>Wallet</span><strong>{account ? short(account) : 'Not connected'}</strong></div><div><span>Network status</span><strong>{network}</strong></div></div>{fltestMode && fltestReview && <div className="notice"><strong>FLTEST read-only transaction review · no first buy</strong><div className="detailsTable"><div><span>Creator</span><strong className="mono">{fltestReview.from}</strong></div><div><span>Factory</span><strong className="mono">{fltestReview.to}</strong></div><div><span>Config</span><strong>#{fltestReview.configId}</strong></div><div><span>Metadata URI</span><strong className="mono">{fltestReview.metadataURI}</strong></div><div><span>Calldata hash</span><strong className="mono">{fltestReview.calldataHash}</strong></div><div><span>Nonce</span><strong>{fltestReview.nonce}</strong></div><div><span>Value</span><strong>{fltestReview.valueWei} wei</strong></div><div><span>Gas estimate / limit</span><strong>{fltestReview.gasEstimate} / {fltestReview.gasLimit}</strong></div><div><span>Max fee / priority</span><strong>{fltestReview.maxFeePerGas} / {fltestReview.maxPriorityFeePerGas} wei</strong></div><div><span>L1 upper bound</span><strong>{fltestReview.l1UpperBoundWei} wei</strong></div><div><span>Planning reserve / balance</span><strong>{fltestReview.reserveWei} / {fltestReview.balanceWei} wei</strong></div></div><details><summary>Full unsigned calldata</summary><code style={{ overflowWrap: "anywhere" }}>{fltestReview.data}</code></details><p className="hint">Review the wallet fee preview before Confirm. Only a canonical receipt with 12 confirmations can mark the launch successful.</p></div>}{pending && <div className="notice">A launch transaction is pending or its outcome is unknown: <a href={txLink(pending.hash)} target="_blank" rel="noreferrer">{short(pending.hash)} ↗</a><button onClick={recover} disabled={busy}>Check receipt</button></div>}<div className="actions"><button className="button secondary" onClick={() => setStep(2)}>← Back</button>{!account ? <button className="button primary" onClick={onConnect}>Connect Wallet</button> : <button className="button primary" disabled={busy || !!pending || network !== 'GIWA Sepolia'} onClick={fltestMode && !fltestReview ? prepareFltest : launch}>{busy ? 'Preparing…' : fltestMode && !fltestReview ? 'Prepare FLTEST review' : 'Confirm launch in wallet →'}</button>}</div></>}{error && <div role="alert" className="notice error">{error}</div>}</div><aside className="card previewCard"><div className="eyebrow">{fltestMode && !!form.image ? "LOCAL PREVIEW · IMAGE NOT IN PINNED METADATA" : "LIVE PREVIEW"}</div>{step >= 2 && <div className="firstBuyControls"><label>Optional first buy (quote asset)<input inputMode="decimal" value={firstBuy} disabled={fltestMode} onChange={e => { setFltestReview(null); setFirstBuy(e.target.value); }} placeholder={fltestMode ? "Disabled for FLTEST" : "0.00"} /></label><label>First-buy slippage %<input inputMode="decimal" value={firstBuySlippage} onChange={e => setFirstBuySlippage(e.target.value)} /></label><p className="hint">Uses a fresh SDK pre-launch quote and limited approval. Leave empty to launch without buying.</p></div>}<div className="previewArtwork">{form.image ? <img src={form.image} alt="" /> : <span>✦</span>}</div><h3>{form.name || 'Your token name'}</h3><p className="muted">${form.symbol || 'TICKER'} · {form.category}</p><p>{form.description || 'Your token story will appear here.'}</p><div className="cardDivider"/><div className="detailsTable"><div><span>Chain</span><strong>GIWA Sepolia</strong></div><div><span>Market</span><strong>Ammora launch curve</strong></div></div></aside></div></>}</section>;
}

function TokenPage({ launch, address, account, catalogError, onConnect }: { launch?: Launch; address: string; account?: Address; catalogError: string; onConnect: () => void }) {
  const [meta, setMeta] = useState<Metadata>(); const [state, setState] = useState<Awaited<ReturnType<AmmoraV4LaunchCurveClient['getStateAtBlock']>>>(); const [progress, setProgress] = useState<Awaited<ReturnType<AmmoraV4LaunchCurveClient['getMigrationProgressAtBlock']>>>(); const [error, setError] = useState(''); const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => { if (!launch) return; if (/^https:\/\//.test(launch.metadataURI)) fetch(launch.metadataURI).then(r => r.ok ? r.json() : null).then(setMeta).catch(() => {}); const sdk = v4Curve(launch.curve); retryRead(() => publicClient.getBlockNumber().then(block => Promise.all([sdk.getStateAtBlock(block), sdk.getMigrationProgressAtBlock(block)]))).then(([s,p]) => { setState(s); setProgress(p); setError(''); }).catch(e => setError(niceError(e))); }, [launch, refreshKey]);
  if (!launch) return <section className="section"><div className="empty"><h2>Token not in verified catalog</h2><p>{catalogError || `No confirmed factory launch for ${address}. Catalog indexing may still be in progress.`}</p><Link className="button secondary" href="/discover">← Discover</Link></div></section>;
  return <section className="section tokenPage"><Link className="backLink" href="/discover">← Back to Discover</Link><div className="tokenHeading"><div className="tokenAvatar large">{meta?.image ? <img src={meta.image} alt="" /> : '✦'}</div><div><span className="eyebrow">AMMORA LAUNCH · GIWA SEPOLIA</span><h1>{meta?.name || short(launch.token)} <small>{meta?.symbol ? `$${meta.symbol}` : ''}</small></h1><p>{meta?.description || 'No description available.'}</p></div><span className="statusPill">{progress?.migrated ? 'Graduated' : state ? 'Launch curve' : 'Status N/A'}</span></div><div className="tokenLayout"><div><div className="metricGrid"><div className="card metric"><span>Price</span><strong>N/A</strong><small>No verified normalized price feed</small></div><div className="card metric"><span>Volume</span><strong>N/A</strong><small>No indexed trade volume</small></div><div className="card metric"><span>Market cap</span><strong>N/A</strong><small>Not derived from supply assumptions</small></div></div><div className="card infoCard"><h2>Token overview</h2><div className="detailsTable"><div><span>Token address</span><a href={addressLink(launch.token)} target="_blank" rel="noreferrer">{short(launch.token)} ↗</a></div><div><span>Creator</span><a href={addressLink(launch.creator)} target="_blank" rel="noreferrer">{short(launch.creator)} ↗</a></div><div><span>Quote asset</span><strong>{state ? <a href={addressLink(state.quoteToken)} target="_blank" rel="noreferrer">{short(state.quoteToken)} ↗</a> : 'N/A'}</strong></div><div><span>Curve</span><a href={addressLink(launch.curve)} target="_blank" rel="noreferrer">{short(launch.curve)} ↗</a></div><div><span>Config ID</span><strong>#{launch.configId}</strong></div><div><span>Graduation progress</span><strong>{progress ? `${progress.progressBps / 100}%` : 'N/A'}</strong></div><div><span>Confirmed launch</span><a href={txLink(launch.hash)} target="_blank" rel="noreferrer">{short(launch.hash)} ↗</a></div></div>{meta && <div className="socials">{external(meta.website,'Website')}{external(meta.x,'X')}{external(meta.telegram,'Telegram')}{external(meta.discord,'Discord')}</div>}</div><div className="card infoCard"><div className="sectionHeading compact"><h2>Activity</h2><button className="textButton" onClick={() => setRefreshKey(n => n + 1)}>Refresh ↻</button></div><div className="activityRow"><span>✦ Launch</span><span>{short(launch.hash)}</span><a href={txLink(launch.hash)} target="_blank" rel="noreferrer">Explorer ↗</a></div><p className="hint">Trade history requires confirmed swap event indexing and is currently unavailable.</p></div></div><Trade launch={launch} account={account} state={state} graduated={!!progress?.migrated} onConnect={onConnect} onRefresh={() => setRefreshKey(n => n + 1)} /> </div>{error && <div className="notice error">Market state unavailable: {error}</div>}</section>;
}
function Trade({ launch, account, state, graduated, onConnect, onRefresh }: { launch: Launch; account?: Address; state?: Awaited<ReturnType<AmmoraV4LaunchCurveClient['getStateAtBlock']>>; graduated: boolean; onConnect: () => void; onRefresh: () => void }) {
  const [side, setSide] = useState<'Buy' | 'Sell'>('Buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [quote, setQuote] = useState<TradePlan>();
  const [quoteAt, setQuoteAt] = useState(0);
  const [balance, setBalance] = useState('N/A');
  const [decimals, setDecimals] = useState(18);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [quoteBusy, setQuoteBusy] = useState(false);
  const [hash, setHash] = useState<Hex>();
  const [balanceVersion, setBalanceVersion] = useState(0);
  const [tradeResult, setTradeResult] = useState('');
  const lock = useRef(false);
  const quoteLock = useRef(false);
  const inputToken = side === 'Buy' ? state?.quoteToken : launch.token;
  const showWeth = launch.token.toLowerCase() === fltestToken.toLowerCase() && state?.quoteToken.toLowerCase() === giwaWeth.toLowerCase();
  useEffect(() => {
    let active = true;
    setQuote(undefined);
    if (!account || !inputToken) { setBalance('N/A'); return; }
    retryRead(() => Promise.all([
      publicClient.readContract({ address: inputToken, abi: erc20Abi, functionName: 'decimals' }),
      publicClient.readContract({ address: inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ])).then(([d, b]) => { if (active) { setDecimals(d); setBalance(formatUnits(b, d)); } }).catch(() => { if (active) setBalance('N/A'); });
    return () => { active = false; };
  }, [account, inputToken, side, balanceVersion]);
  const planQuote = async () => {
    if (quoteLock.current) return;
    quoteLock.current = true; setQuoteBusy(true); setError(''); setQuote(undefined);
    try {
      if (!account || !state) throw new Error('Connect wallet and load market state');
      const raw = parseUnits(amount, decimals);
      if (raw <= 0n) throw new Error('Enter a positive amount');
      const bps = Math.round(Number(slippage) * 100);
      if (!Number.isInteger(bps) || bps < 1 || bps > 1000) throw new Error('Slippage must be 0.01–10%');
      const result = await retryRead(() => prepareTrade(launch, state, graduated, side, raw, bps, account));
      setQuote(result); setQuoteAt(Date.now());
    } catch (e) { setError(niceError(e)); }
    finally { quoteLock.current = false; setQuoteBusy(false); }
  };
  const submit = async () => {
    if (lock.current || busy) return;
    lock.current = true; setBusy(true); setError(''); setTradeResult('');
    let submitted: Hex | undefined;
    let approvalHash: Hex | undefined;
    let approvalConfirmed = false;
    let walletOpened = false;
    try {
      if (!account || !state || !inputToken || !quote) throw new Error('Get a fresh quote first');
      if (pendingWalletAttempt(account)) throw new Error('Previous wallet request has an unresolved outcome. Check its receipt in Activity; do not retry.');
      if (loadActivity().some(row => row.account.toLowerCase() === account.toLowerCase() && ['Buy', 'Sell', 'Approval', 'Wrap', 'Unwrap'].includes(row.kind) && ['pending', 'unknown'].includes(row.status))) throw new Error('Resolve the previous wallet transaction in Activity before another trade');
      if (Date.now() - quoteAt > 30_000) throw new Error('Quote expired; refresh it');
      await checkNetwork(); await assertRuntime();
      const raw = parseUnits(amount, decimals);
      const available = await retryRead(() => publicClient.readContract({ address: inputToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] }));
      if (available < raw) throw new Error(side === 'Buy' ? 'Not enough WETH. Wrap ETH first.' : 'Not enough FLTEST to sell.');
      const bps = Math.round(Number(slippage) * 100);
      const fresh = await retryRead(() => prepareTrade(launch, state, graduated, side, raw, bps, account));
      if (Date.now() - quoteAt > 30_000 || fresh.quote.amountOut < quote.quote.minimumAmountOut) throw new Error('Quote expired or price changed; get a new quote');
      if (fresh.approvalRequirement.token.toLowerCase() !== inputToken.toLowerCase() || fresh.approvalRequirement.spender.toLowerCase() !== fresh.routeTarget.toLowerCase()) throw new Error('Unexpected approval target');
      const outputToken = side === 'Buy' ? launch.token : state.quoteToken;
      const before = await retryRead(() => publicClient.readContract({ address: outputToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] }));
      await limitedApproval(inputToken, fresh.approvalRequirement.spender, fresh.approvalRequirement.amount, account, h => {
        approvalHash = h; recordWalletHash(account, h); saveActivity({ hash: h, kind: 'Approval', account, token: launch.token, status: 'pending', at: new Date().toISOString() });
      }, () => { walletOpened = true; beginWalletAttempt(account, 'Approval'); });
      if (approvalHash) { approvalConfirmed = true; finishWalletAttempt(account); walletOpened = false; saveActivity({ hash: approvalHash, kind: 'Approval', account, token: launch.token, status: 'confirmed', at: new Date().toISOString() }); }
      const tx = await execute(fresh.transaction, account, [fresh.routeTarget], h => {
        submitted = h; recordWalletHash(account, h); setHash(h); saveActivity({ hash: h, kind: side, account, token: launch.token, status: 'pending', at: new Date().toISOString() });
      }, () => { walletOpened = true; beginWalletAttempt(account, side); });
      finishWalletAttempt(account); walletOpened = false;
      saveActivity({ hash: tx, kind: side, account, token: launch.token, status: 'confirmed', at: new Date().toISOString() });
      setAmount(''); setQuote(undefined); setBalanceVersion(n => n + 1); onRefresh();
      try {
        const after = await retryRead(() => publicClient.readContract({ address: outputToken, abi: erc20Abi, functionName: 'balanceOf', args: [account] }));
        setTradeResult(after - before >= fresh.quote.minimumAmountOut ? `Receipt confirmed; received ${after - before} raw units.` : 'Receipt confirmed; balance delta needs review in Activity.');
      } catch { setTradeResult('Receipt confirmed; balance readback is temporarily unavailable.'); }
    } catch (e) {
      if (account) { settleWalletError(account, e, walletOpened, submitted || approvalHash); if (niceError(e).includes('reverted') && (submitted || approvalHash)) finishWalletAttempt(account); }
      if (approvalHash && !approvalConfirmed && account) saveActivity({ hash: approvalHash, kind: 'Approval', account, token: launch.token, status: niceError(e).includes('reverted') ? 'failed' : 'unknown', at: new Date().toISOString() });
      if (submitted && account) saveActivity({ hash: submitted, kind: side, account, token: launch.token, status: niceError(e).includes('reverted') ? 'failed' : 'unknown', at: new Date().toISOString() });
      setError(niceError(e));
    } finally { lock.current = false; setBusy(false); }
  };
  return <aside className="card tradeCard">
    <div className="tradeTabs"><button className={side === 'Buy' ? 'selected' : ''} onClick={() => { setSide('Buy'); setQuote(undefined); }}>Buy</button><button className={side === 'Sell' ? 'selected' : ''} onClick={() => { setSide('Sell'); setQuote(undefined); }}>Sell</button></div>
    <label>Amount to {side === 'Buy' ? 'spend' : 'sell'}<div className="amountInput"><input inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setQuote(undefined); }} placeholder={side === 'Buy' && showWeth ? '0.00001' : '0.00'} /><span>{side === 'Buy' && showWeth ? 'WETH' : side === 'Buy' ? 'Quote' : 'FLTEST'}</span></div></label>
    <p className="balance">Balance: {balance}</p>
    <label>Slippage tolerance<div className="amountInput small"><input inputMode="decimal" value={slippage} onChange={e => { setSlippage(e.target.value); setQuote(undefined); }} /><span>%</span></div></label>
    {quote && <div className="detailsTable quoteStats"><div><span>Estimated received</span><strong>{quote.quote.amountOut.toString()} raw</strong></div><div><span>Minimum received</span><strong>{quote.quote.minimumAmountOut.toString()} raw</strong></div><div><span>Fee</span><strong>{quote.quote.fee.toString()} raw</strong></div>{quote.quote.priceImpactBps !== undefined && <div><span>Price impact</span><strong>{formatUnits(quote.quote.priceImpactBps, 2)}%</strong></div>}<div><span>Quote age</span><strong>{Math.round((Date.now() - quoteAt) / 1000)} sec</strong></div></div>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {tradeResult && <div className="notice">{tradeResult}</div>}
    {hash && <div className="notice">Transaction {tradeResult.startsWith('Receipt confirmed') ? 'confirmed' : 'submitted'}: <a href={txLink(hash)} target="_blank" rel="noreferrer">{short(hash)} ↗</a>{!tradeResult && '. If RPC timed out, check its receipt in Activity before another action.'}</div>}
    {!account ? <button className="button primary wide" onClick={onConnect}>Connect Wallet</button> : <><button className="button secondary wide" disabled={busy || quoteBusy || !state || (!graduated && state.status !== 1)} onClick={planQuote}>{quoteBusy ? 'Quoting…' : 'Get live quote'}</button><button className="button primary wide" disabled={busy || quoteBusy || !quote || Date.now() - quoteAt > 30_000} onClick={submit}>{busy ? 'Waiting…' : `Confirm ${side.toLowerCase()} in wallet →`}</button></>}
    {showWeth && <WethControls account={account} onBalanceChanged={() => setBalanceVersion(n => n + 1)} />}
    <p className="hint">Exact-input Ammora {graduated ? 'graduated pool' : 'launch curve'} route · exact allowance · separate wallet confirmation for each transaction.</p>
  </aside>;
}
function WethControls({ account, onBalanceChanged }: { account?: Address; onBalanceChanged: () => void }) {
  const [ethAmount, setEthAmount] = useState('0.00001');
  const [wethAmount, setWethAmount] = useState('');
  const [balances, setBalances] = useState('Checking ETH and WETH…');
  const [error, setError] = useState('');
  const [hash, setHash] = useState<Hex>();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const lock = useRef(false);
  useEffect(() => {
    if (!account) { setBalances('Connect wallet to see balances'); return; }
    let active = true;
    retryRead(() => Promise.all([
      publicClient.getBalance({ address: account }),
      publicClient.readContract({ address: giwaWeth, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ])).then(([eth, weth]) => { if (active) setBalances(`${formatUnits(eth, 18)} ETH · ${formatUnits(weth, 18)} WETH`); }).catch(() => { if (active) setBalances('Balances temporarily unavailable'); });
    return () => { active = false; };
  }, [account, version]);
  const convert = async (kind: 'Wrap' | 'Unwrap') => {
    if (!account || lock.current) return;
    lock.current = true; setBusy(true); setError(''); setHash(undefined); setConfirmed(false);
    let submitted: Hex | undefined;
    let walletOpened = false;
    try {
      if (pendingWalletAttempt(account)) throw new Error('Previous wallet request has an unresolved outcome. Check its receipt in Activity; do not retry.');
      if (loadActivity().some(row => row.account.toLowerCase() === account.toLowerCase() && ['Wrap', 'Unwrap', 'Approval', 'Buy', 'Sell'].includes(row.kind) && ['pending', 'unknown'].includes(row.status))) throw new Error('Resolve the previous wallet transaction in Activity first');
      await checkNetwork();
      const amount = parseUnits(kind === 'Wrap' ? ethAmount : wethAmount, 18);
      if (amount <= 0n) throw new Error('Enter a positive amount');
      const [code, name, decimals] = await retryRead(() => Promise.all([
        publicClient.getCode({ address: giwaWeth }),
        publicClient.readContract({ address: giwaWeth, abi: wethAbi, functionName: 'name' }),
        publicClient.readContract({ address: giwaWeth, abi: wethAbi, functionName: 'decimals' }),
      ]));
      if (!code || name !== 'Wrapped Ether' || decimals !== 18) throw new Error('GIWA WETH contract verification failed');
      const [eth, weth] = await retryRead(() => Promise.all([
        publicClient.getBalance({ address: account }),
        publicClient.readContract({ address: giwaWeth, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      ]));
      const plan = wethPlan(kind, amount, eth, weth);
      const tx = await execute(plan, account, [giwaWeth], h => {
        submitted = h; recordWalletHash(account, h); setHash(h); saveActivity({ hash: h, kind, account, token: fltestToken, status: 'pending', at: new Date().toISOString() });
      }, () => { walletOpened = true; beginWalletAttempt(account, kind); });
      finishWalletAttempt(account); walletOpened = false;
      saveActivity({ hash: tx, kind, account, token: fltestToken, status: 'confirmed', at: new Date().toISOString() });
      setConfirmed(true);
      setVersion(n => n + 1); onBalanceChanged();
    } catch (e) {
      settleWalletError(account, e, walletOpened, submitted);
      if (submitted && niceError(e).includes('reverted')) finishWalletAttempt(account);
      if (submitted) saveActivity({ hash: submitted, kind, account, token: fltestToken, status: niceError(e).includes('reverted') ? 'failed' : 'unknown', at: new Date().toISOString() });
      setError(niceError(e));
    } finally { lock.current = false; setBusy(false); }
  };
  return <div className="card" style={{ padding: 16, marginTop: 20 }}>
    <strong>ETH ↔ WETH on GIWA Sepolia</strong><p className="hint">Wrap before buying FLTEST. Unwrap received WETH after selling. Each action opens a separate wallet confirmation.</p>
    <p className="balance">{balances}</p>
    <label>ETH to wrap<input inputMode="decimal" value={ethAmount} onChange={e => setEthAmount(e.target.value)} placeholder="0.00001" /></label>
    <button className="button secondary wide" disabled={!account || busy} onClick={() => convert('Wrap')}>{busy ? 'Waiting…' : 'Wrap ETH → WETH in wallet'}</button>
    <label>WETH to unwrap<input inputMode="decimal" value={wethAmount} onChange={e => setWethAmount(e.target.value)} placeholder="0.00001" /></label>
    <button className="button secondary wide" disabled={!account || busy} onClick={() => convert('Unwrap')}>{busy ? 'Waiting…' : 'Unwrap WETH → ETH in wallet'}</button>
    {hash && <div className="notice">Transaction {confirmed ? 'confirmed' : 'submitted'}: <a href={txLink(hash)} target="_blank" rel="noreferrer">{short(hash)} ↗</a>{!confirmed && '. Check Activity if receipt is delayed.'}</div>}
    {error && <div role="alert" className="notice error">{error}</div>}
  </div>;
}

function Portfolio({ account, catalog, activity, onConnect }: { account?: Address; catalog: Launch[]; activity: Activity[]; onConnect: () => void }) {
  const [balances, setBalances] = useState<Record<string,string>>({}); const [error, setError] = useState('');
  useEffect(() => { if (!account) { setBalances({}); return; } let cancelled = false; Promise.all(catalog.slice(0,100).map(async item => { try { const [balance, decimals] = await Promise.all([publicClient.readContract({ address: item.token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }), publicClient.readContract({ address: item.token, abi: erc20Abi, functionName: 'decimals' })]); return [item.token, formatUnits(balance,decimals)] as const; } catch { return [item.token,'N/A'] as const; } })).then(rows => { if (!cancelled) setBalances(Object.fromEntries(rows)); }).catch(e => setError(niceError(e))); return () => { cancelled = true; }; }, [account, catalog]);
  if (!account) return <WalletGate title="Your portfolio" onConnect={onConnect} />;
  const owned = catalog.filter(item => item.creator.toLowerCase() === account.toLowerCase()); const held = catalog.filter(item => balances[item.token] && balances[item.token] !== '0' && balances[item.token] !== 'N/A');
  return <section className="section"><div className="eyebrow">YOUR WALLET</div><h1 className="pageTitle">Portfolio</h1><p className="pageLead">Balances for {short(account)} from confirmed catalog tokens.</p>{error && <div className="notice error">{error}</div>}<div className="portfolioStats"><div className="card metric"><span>Created</span><strong>{owned.length}</strong></div><div className="card metric"><span>Held tokens</span><strong>{held.length}</strong></div><div className="card metric"><span>Confirmed operations</span><strong>{activity.filter(a => a.account.toLowerCase() === account.toLowerCase() && a.status === 'confirmed').length}</strong></div></div><h2>Created tokens</h2>{owned.length ? <div className="tokenList">{owned.map(item => <PortfolioRow key={item.token} item={item} balance={balances[item.token]} />)}</div> : <div className="empty compactEmpty">No confirmed launches from this wallet.</div>}<h2>Token balances</h2>{held.length ? <div className="tokenList">{held.map(item => <PortfolioRow key={item.token} item={item} balance={balances[item.token]} />)}</div> : <div className="empty compactEmpty">No indexed token balances found for this wallet.</div>}</section>;
}
function PortfolioRow({ item, balance }: { item: Launch; balance?: string }) { return <Link href={`/token/${item.token}`} className="card portfolioRow"><span className="tokenAvatar">✦</span><span><strong>{short(item.token)}</strong><small>Config #{item.configId}</small></span><span className="rowBalance">{balance || 'N/A'}</span><span>↗</span></Link>; }
function ActivityView({ account, activity, onConnect }: { account?: Address; activity: Activity[]; onConnect: () => void }) { const [error, setError] = useState(''); if (!account) return <WalletGate title="Your activity" onConnect={onConnect} />; const mine = activity.filter(item => item.account.toLowerCase() === account.toLowerCase()); const reconcile = async (row: Activity) => { setError(''); try { const receipt = await retryRead(() => publicClient.getTransactionReceipt({ hash: row.hash })); saveActivity({ ...row, status: receipt.status === 'success' ? 'confirmed' : 'failed' }); const marker = pendingWalletAttempt(row.account); if (marker && JSON.parse(marker).hash === row.hash) finishWalletAttempt(row.account); } catch (e) { setError(`Receipt unavailable for ${short(row.hash)}: ${niceError(e)}`); } }; return <section className="section"><div className="eyebrow">TRANSACTION JOURNAL</div><h1 className="pageTitle">Activity</h1><p className="pageLead">Local wallet activity with GIWA Explorer links. Earlier confirmed Buy/Sell transactions from other browser sessions are not indexed. Unknown outcomes are never retried automatically.</p>{error && <div className="notice error">{error}</div>}{mine.length ? <div className="card activityTable">{mine.map(row => <div className="activityRow" key={row.hash}><span className="activityType">{row.kind}</span><span className={'activityStatus ' + row.status}>{row.status}</span><span>{new Date(row.at).toLocaleString()}</span><span>{short(row.hash)}</span><span><a href={txLink(row.hash)} target="_blank" rel="noreferrer">Explorer ↗</a>{(row.status === 'pending' || row.status === 'unknown') && <button className="textButton" onClick={() => reconcile(row)}>Check receipt</button>}</span></div>)}</div> : <div className="empty"><span className="emptyIcon">◌</span><h3>No transactions yet</h3><p>Your wallet’s submitted launch and trade transactions will appear here.</p></div>}</section>; }
function WalletGate({ title, onConnect }: { title: string; onConnect: () => void }) { return <section className="section"><div className="empty walletGate"><span className="emptyIcon">◇</span><h1>{title}</h1><p>Connect your wallet to see account-specific balances and activity.</p><button className="button primary" onClick={onConnect}>Connect Wallet</button></div></section>; }
