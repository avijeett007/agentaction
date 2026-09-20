/**
 * The whole app: two tabs and a small pushed-screen stack.
 *
 * There is no navigation library on purpose. Six screens and one level of
 * depth do not need one, and a hand-rolled stack keeps the notification
 * deep-link (open *this* request on *that* account) to three lines rather than
 * a linking configuration.
 *
 * `SafeAreaProvider` wraps everything because every screen below measures the
 * system insets itself. Without it `useSafeAreaInsets` reports zero, and on a
 * foldable that puts the tab bar under the gesture bar, where it cannot be
 * tapped at all.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import type { Account } from './lib/accounts';
import { listAccounts } from './lib/accounts';
import { usePendingRequests } from './lib/pending';
import {
  addRequestOpenListener,
  configureNotificationHandler,
  getInitialRequestTarget,
  syncPushToken,
} from './lib/push';
import type { RequestTarget } from './lib/push';
import { palette } from './lib/theme';
import { Loading } from './components/ui';
import { TabBar } from './components/TabBar';
import type { TabKey } from './components/TabBar';
import { AboutScreen } from './screens/AboutScreen';
import { AccountsScreen } from './screens/AccountsScreen';
import { PairScreen } from './screens/PairScreen';
import { PendingScreen } from './screens/PendingScreen';
import { RequestScreen } from './screens/RequestScreen';
import { SettingsScreen } from './screens/SettingsScreen';

configureNotificationHandler();

type Pushed =
  | { name: 'pair' }
  | { name: 'about' }
  | { name: 'request'; deviceId: string; requestId: string }
  | { name: 'settings'; deviceId: string };

export default function App() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <StatusBar style="light" />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [tab, setTab] = useState<TabKey>('pending');
  const [pushed, setPushed] = useState<Pushed | null>(null);

  const pending = usePendingRequests(accounts ?? EMPTY_ACCOUNTS);

  const refresh = useCallback(async () => {
    const next = await listAccounts();
    setAccounts(next);
    return next;
  }, []);

  /** Opens a request from a notification, but only for an account we still hold. */
  const openTarget = useCallback((target: RequestTarget, known: Account[]) => {
    if (!known.some(a => a.deviceId === target.deviceId)) return;
    setPushed({ name: 'request', deviceId: target.deviceId, requestId: target.requestId });
  }, []);

  useEffect(() => {
    void (async () => {
      const loaded = await refresh();
      // Fire and forget: a failed token sync must not hold up the first screen.
      // Whatever went wrong is recorded and shown in Settings → Notifications.
      void syncPushToken(loaded);

      // A notification may have cold-started the app.
      const initial = await getInitialRequestTarget();
      if (initial) openTarget(initial, loaded);
    })();
  }, [refresh, openTarget]);

  useEffect(() => {
    return addRequestOpenListener(target => {
      // Read the list at tap time: the app may have paired since mount.
      void listAccounts().then(known => openTarget(target, known));
    });
  }, [openTarget]);

  if (accounts === null) {
    return (
      <View style={styles.flex}>
        <Loading label="Opening AgentAction…" />
      </View>
    );
  }

  const pushedAccount =
    pushed && (pushed.name === 'request' || pushed.name === 'settings')
      ? accounts.find(a => a.deviceId === pushed.deviceId)
      : undefined;

  // A pushed screen whose account has gone (unpaired elsewhere) falls back to
  // the tabs rather than rendering against nothing.
  if (pushed && (pushed.name === 'request' || pushed.name === 'settings') && !pushedAccount) {
    setPushed(null);
  }

  if (pushed?.name === 'pair') {
    return (
      <View style={styles.flex}>
        <PairScreen
          onCancel={() => setPushed(null)}
          onPaired={async () => {
            await refresh();
            await pending.reload();
            setPushed(null);
            setTab('accounts');
          }}
        />
      </View>
    );
  }

  if (pushed?.name === 'about') {
    return (
      <View style={styles.flex}>
        <AboutScreen onBack={() => setPushed(null)} />
      </View>
    );
  }

  if (pushed?.name === 'request' && pushedAccount) {
    return (
      <View style={styles.flex}>
        <RequestScreen
          account={pushedAccount}
          requestId={pushed.requestId}
          onBack={() => setPushed(null)}
          onDecided={async () => {
            setPushed(null);
            await pending.reload();
          }}
        />
      </View>
    );
  }

  if (pushed?.name === 'settings' && pushedAccount) {
    return (
      <View style={styles.flex}>
        <SettingsScreen
          account={pushedAccount}
          onBack={() => setPushed(null)}
          onChanged={refresh}
          onAbout={() => setPushed({ name: 'about' })}
          onUnpaired={async () => {
            await refresh();
            await pending.reload();
            setPushed(null);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.flex}>
      <View style={styles.flex}>
        {tab === 'pending' ? (
          <PendingScreen
            accounts={accounts}
            pending={pending}
            onPair={() => setPushed({ name: 'pair' })}
            onOpen={(account, requestId) =>
              setPushed({ name: 'request', deviceId: account.deviceId, requestId })
            }
          />
        ) : (
          <AccountsScreen
            accounts={accounts}
            onPair={() => setPushed({ name: 'pair' })}
            onAbout={() => setPushed({ name: 'about' })}
            onOpenAccount={account => setPushed({ name: 'settings', deviceId: account.deviceId })}
          />
        )}
      </View>
      <TabBar tab={tab} onSelect={setTab} waitingCount={pending.items.length} />
    </View>
  );
}

/** A stable empty list, so the pending hook does not refetch on every render. */
const EMPTY_ACCOUNTS: Account[] = [];

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
});
