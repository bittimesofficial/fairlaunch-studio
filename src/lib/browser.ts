import { createWalletClient, custom, erc20Abi, getAddress, isAddress, type Address, type Hex } from 'viem';
import { chain, publicClient, explorer, factory } from './chain';

export type Ethereum = { request: (args: { method: string; params?: unknown[] }) => Promise<unknown>; on?: (event: string, handler: (...args: unknown[]) => void) => void; removeListener?: (event: string, handler: (...args: unknown[]) => void) => void };
declare global { interface Window { ethereum?: Ethereum } }
export function provider(): Ethereum { if (!window.ethereum) throw new Error('Install an EVM wallet to continue'); return window.ethereum; }
export async function connectedAccount(): Promise<Address> {
  const accounts = await provider().request({ method: 'eth_requestAccounts' }) as string[];
  if (!accounts?.[0] || !isAddress(accounts[0])) throw new Error('Wallet connection cancelled');
  return getAddress(accounts[0]);
}
export async function checkNetwork(): Promise<void> {
  const id = await provider().request({ method: 'eth_chainId' });
  if (id !== '0x164ce') throw new Error('Switch your wallet to GIWA Sepolia (91342)');
}
export function wallet() { return createWalletClient({ chain, transport: custom(provider()) }); }
export async function assertRuntime(): Promise<void> {
  const response = await fetch('/api/preflight', { cache: 'no-store' });
  const result = await response.json();
  if (!response.ok || result.chainId !== 91342 || result.checkedContracts < 1) throw new Error(result.error || 'Ammora runtime attestation failed');
}
export type Transaction = { to: Address; data: Hex; value?: bigint };
export function assertPlan(plan: Transaction, targets: Address[]) {
  if (!targets.some(target => target.toLowerCase() === plan.to.toLowerCase())) throw new Error('Unapproved transaction target');
  if (!/^0x[0-9a-f]{8,}$/i.test(plan.data)) throw new Error('Invalid calldata');
  if ((plan.value || 0n) < 0n) throw new Error('Invalid transaction value');
}
export async function execute(plan: Transaction, account: Address, targets: Address[], onHash: (hash: Hex) => void, onBeforeSend?: () => void): Promise<Hex> {
  await checkNetwork(); assertPlan(plan, targets);
  const current = await provider().request({ method: 'eth_accounts' }) as string[];
  if (!current.some(item => item.toLowerCase() === account.toLowerCase())) throw new Error('Wallet account changed');
  await publicClient.call({ account, to: plan.to, data: plan.data, value: plan.value || 0n });
  await publicClient.estimateGas({ account, to: plan.to, data: plan.data, value: plan.value || 0n });
  onBeforeSend?.();
  const hash = await wallet().sendTransaction({ account, chain, to: plan.to, data: plan.data, value: plan.value || 0n });
  onHash(hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 45_000, confirmations: 2 });
  if (receipt.status !== 'success') throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}
export function approvalNeedsUpdate(allowance: bigint, amount: bigint): boolean {
  if (allowance < 0n || amount <= 0n) throw new Error('Invalid approval amount');
  return allowance !== amount;
}
export async function limitedApproval(token: Address, spender: Address, amount: bigint, account: Address, onHash: (hash: Hex) => void, onBeforeSend?: () => void): Promise<boolean> {
  if (!isAddress(token) || !isAddress(spender) || amount <= 0n) throw new Error('Invalid approval');
  const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  if (!approvalNeedsUpdate(allowance, amount)) return false;
  const { encodeFunctionData } = await import('viem');
  await execute({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }) }, account, [token], onHash, onBeforeSend);
  const confirmedAllowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] });
  if (confirmedAllowance !== amount) throw new Error('Exact approval not confirmed');
  return true;
}
export const txLink = (hash: string) => `${explorer}/tx/${hash}`;
export const addressLink = (address: string) => `${explorer}/address/${address}`;
export { factory };
