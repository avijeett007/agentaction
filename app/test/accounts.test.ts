/** Multi-account storage: add, list, update, remove. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __storageKey,
  addAccount,
  clearAccounts,
  getAccount,
  listAccounts,
  removeAccount,
  updateAccount,
} from '../lib/accounts';
import type { Account } from '../lib/accounts';

function account(overrides: Partial<Account> = {}): Account {
  return {
    deviceId: 'dev_1',
    serverUrl: 'https://approvals.example.com',
    subjectLabel: 'ops@acme.com',
    deviceLabel: "Sam's iPhone",
    brand: { name: 'Acme', logoUrl: null, color: '#123456' },
    createdAt: '2026-09-20T00:00:00.000Z',
    keyRef: 'ref1',
    approvalKeyMode: 'keychain',
    ...overrides,
  };
}

beforeEach(async () => {
  await clearAccounts();
});

describe('listAccounts', () => {
  it('starts empty', async () => {
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it('returns an empty list rather than throwing on corrupt storage', async () => {
    // A crash here would leave the owner on a permanently broken screen with
    // no way back; re-pairing is the recoverable outcome.
    await AsyncStorage.setItem(__storageKey, 'not json at all');
    await expect(listAccounts()).resolves.toEqual([]);
  });

  it('drops entries that are not accounts', async () => {
    await AsyncStorage.setItem(__storageKey, JSON.stringify([account(), { nonsense: true }, null]));
    await expect(listAccounts()).resolves.toHaveLength(1);
  });
});

describe('addAccount', () => {
  it('adds several accounts and keeps them all', async () => {
    await addAccount(account({ deviceId: 'dev_1', brand: { name: 'Acme', logoUrl: null, color: '#111111' } }));
    await addAccount(account({ deviceId: 'dev_2', brand: { name: 'Globex', logoUrl: null, color: '#222222' } }));

    const accounts = await listAccounts();
    expect(accounts.map(a => a.brand.name)).toEqual(['Acme', 'Globex']);
  });

  it('replaces an account re-paired under the same device id', async () => {
    await addAccount(account({ deviceLabel: 'Old name' }));
    await addAccount(account({ deviceLabel: 'New name' }));

    const accounts = await listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].deviceLabel).toBe('New name');
  });

  it('persists through storage, not just in memory', async () => {
    await addAccount(account());
    const raw = await AsyncStorage.getItem(__storageKey);
    expect(JSON.parse(raw as string)[0].deviceId).toBe('dev_1');
  });
});

describe('getAccount and updateAccount', () => {
  it('finds one account by device id', async () => {
    await addAccount(account({ deviceId: 'dev_1' }));
    await addAccount(account({ deviceId: 'dev_2', subjectLabel: 'finance@globex.com' }));

    await expect(getAccount('dev_2')).resolves.toMatchObject({ subjectLabel: 'finance@globex.com' });
    await expect(getAccount('missing')).resolves.toBeUndefined();
  });

  it('patches only the named account', async () => {
    await addAccount(account({ deviceId: 'dev_1' }));
    await addAccount(account({ deviceId: 'dev_2' }));

    await updateAccount('dev_2', { deviceLabel: 'Work phone', pushToken: 'ExponentPushToken[x]' });

    const accounts = await listAccounts();
    expect(accounts.find(a => a.deviceId === 'dev_1')?.deviceLabel).toBe("Sam's iPhone");
    expect(accounts.find(a => a.deviceId === 'dev_2')).toMatchObject({
      deviceLabel: 'Work phone',
      pushToken: 'ExponentPushToken[x]',
    });
  });

  it('does nothing for an unknown device id', async () => {
    await addAccount(account());
    await updateAccount('nope', { deviceLabel: 'x' });
    await expect(listAccounts()).resolves.toHaveLength(1);
  });
});

describe('removeAccount', () => {
  it('removes one and leaves the rest', async () => {
    await addAccount(account({ deviceId: 'dev_1' }));
    await addAccount(account({ deviceId: 'dev_2' }));

    const remaining = await removeAccount('dev_1');

    expect(remaining.map(a => a.deviceId)).toEqual(['dev_2']);
    await expect(listAccounts()).resolves.toHaveLength(1);
  });

  it('is a no-op for an id that is not paired', async () => {
    await addAccount(account());
    await expect(removeAccount('nope')).resolves.toHaveLength(1);
  });
});
