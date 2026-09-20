/**
 * Everything waiting for a decision, across every paired account, newest first.
 *
 * The fetching lives in `lib/pending.ts` rather than here, because the tab bar
 * badge has to stay correct while the owner is on the other tab.
 */
import { useCallback, useState } from 'react';
import { RefreshControl, StyleSheet, Text, View } from 'react-native';
import type { Account } from '../lib/accounts';
import type { Pending } from '../lib/pending';
import { palette, space, themeFor, type } from '../lib/theme';
import { countdownFor, msUntil } from '../lib/time';
import {
  AppHeader,
  Button,
  EmptyState,
  Loading,
  Notice,
  Row,
  Screen,
  countdownColour,
  useNow,
} from '../components/ui';

export function PendingScreen({
  accounts,
  pending,
  onOpen,
  onPair,
}: {
  accounts: Account[];
  pending: Pending;
  onOpen: (account: Account, requestId: string) => void;
  onPair: () => void;
}) {
  const now = useNow(1000);
  const [refreshing, setRefreshing] = useState(false);
  const { reload } = pending;

  // The spinner stays until the fetch settles, so a pull that finds nothing
  // still reads as "I checked" rather than "nothing happened".
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void reload().finally(() => setRefreshing(false));
  }, [reload]);

  return (
    <View style={styles.flex}>
      <AppHeader subtitle="Waiting for you" />
      <Screen
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={palette.muted}
            colors={[palette.brand]}
            progressBackgroundColor={palette.surface}
          />
        }
      >
        {pending.problem ? <Notice tone="warn">{pending.problem}</Notice> : null}

        {pending.loading && pending.items.length === 0 ? (
          <Loading label="Checking every account…" />
        ) : pending.items.length === 0 ? (
          accounts.length === 0 ? (
            <EmptyState
              icon="qr-code-outline"
              title="No accounts yet"
              action={
                <Button title="Pair a phone" tone="primary" icon="qr-code-outline" onPress={onPair} />
              }
            >
              Pair this phone with an account and approval requests will arrive here, and as a
              notification.
            </EmptyState>
          ) : (
            <EmptyState icon="shield-checkmark-outline" title="Nothing waiting">
              When an agent asks to do something that needs approval, it appears here and this
              phone buzzes. You can leave the app closed.
            </EmptyState>
          )
        ) : (
          pending.items.map(({ account, request }) => {
            const accent = themeFor(account.brand).legible;
            const left = msUntil(request.expiresAt, now);
            return (
              <Row
                key={`${account.deviceId}:${request.id}`}
                tone={accent}
                title={request.title}
                subtitle={request.brandName || account.brand.name}
                meta={`${request.actorLabel} · ${request.resourceKey}`}
                chevron={false}
                // Screen readers get the code digit by digit; read as a number
                // it comes out as "four thousand eight hundred and twenty-one".
                accessibilityLabel={`${request.title}. ${request.brandName || account.brand.name}. Code ${request.code.split('').join(' ')}. ${countdownFor(request.expiresAt, now)} left.`}
                onPress={() => onOpen(account, request.id)}
                right={
                  <View style={styles.right}>
                    <Text style={[type.codeSmall, { color: accent }]}>{request.code}</Text>
                    <Text style={[styles.countdown, { color: countdownColour(left) }]}>
                      {countdownFor(request.expiresAt, now)}
                    </Text>
                  </View>
                }
              />
            );
          })
        )}
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
  right: { alignItems: 'flex-end', gap: space.xs, minWidth: 74 },
  countdown: { fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
