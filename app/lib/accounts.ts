/**
 * The accounts this phone is paired with.
 *
 * One phone can hold several: a contractor may approve actions for two
 * agencies, and each shows its own branding. The list itself holds nothing
 * secret — the private keys live in `lib/keys.ts` / the keychain — so plain
 * async storage is the right place for it.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { ApprovalKeyMode } from './keys';

const STORAGE_KEY = 'agentaction.accounts.v1';

export interface Brand {
  name: string;
  logoUrl: string | null;
  color: string;
}

export interface Account {
  deviceId: string;
  serverUrl: string;
  /** Who this phone approves as, e.g. "ops@acme.com". */
  subjectLabel: string;
  /** What this phone is called on the account, e.g. "Sam's iPhone". */
  deviceLabel: string;
  brand: Brand;
  createdAt: string;
  /** Handle for this account's keypairs in the keychain. */
  keyRef: string;
  approvalKeyMode: ApprovalKeyMode;
  /** Last push token handed to the server, so we only PATCH on a change. */
  pushToken?: string | null;
}

async function read(): Promise<Account[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAccount);
  } catch {
    // A corrupt list must not brick the app. Worst case the owner re-pairs;
    // throwing here would leave them on a permanently broken screen.
    return [];
  }
}

function isAccount(value: unknown): value is Account {
  const a = value as Account;
  return Boolean(a && typeof a.deviceId === 'string' && typeof a.serverUrl === 'string' && a.brand);
}

async function write(accounts: Account[]): Promise<Account[]> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(accounts));
  return accounts;
}

export async function listAccounts(): Promise<Account[]> {
  return read();
}

export async function getAccount(deviceId: string): Promise<Account | undefined> {
  return (await read()).find(a => a.deviceId === deviceId);
}

/** Adds, or replaces an account already paired under the same device id. */
export async function addAccount(account: Account): Promise<Account[]> {
  const accounts = await read();
  const without = accounts.filter(a => a.deviceId !== account.deviceId);
  return write([...without, account]);
}

export async function updateAccount(
  deviceId: string,
  patch: Partial<Omit<Account, 'deviceId'>>,
): Promise<Account[]> {
  const accounts = await read();
  return write(accounts.map(a => (a.deviceId === deviceId ? { ...a, ...patch } : a)));
}

export async function removeAccount(deviceId: string): Promise<Account[]> {
  const accounts = await read();
  return write(accounts.filter(a => a.deviceId !== deviceId));
}

export async function clearAccounts(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}

export const __storageKey = STORAGE_KEY;
