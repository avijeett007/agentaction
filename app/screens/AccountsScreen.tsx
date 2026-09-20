/** Every account this phone is paired with, each in its agency's colour. */
import { StyleSheet, View } from 'react-native';
import type { Account } from '../lib/accounts';
import { DESCRIPTOR, SLOGAN, palette, themeFor } from '../lib/theme';
import { AppHeader, Button, EmptyState, Row, Screen, SectionLabel } from '../components/ui';

export function AccountsScreen({
  accounts,
  onPair,
  onAbout,
  onOpenAccount,
}: {
  accounts: Account[];
  onPair: () => void;
  onAbout: () => void;
  onOpenAccount: (account: Account) => void;
}) {
  const empty = accounts.length === 0;

  return (
    <View style={styles.flex}>
      {/* The one place the app says what it is. Once accounts exist, the
          descriptor goes: the owner knows by then. */}
      <AppHeader subtitle={SLOGAN} descriptor={empty ? DESCRIPTOR : undefined} />
      <Screen>
        {empty ? (
          <EmptyState
            icon="qr-code-outline"
            title="Pair this phone"
            action={
              <Button title="Pair a phone" tone="primary" icon="qr-code-outline" onPress={onPair} />
            }
          >
            In your portal, open Approvals and choose “Add a phone”. Scan the code it shows and
            this phone becomes the last step before an agent can act.
          </EmptyState>
        ) : (
          <>
            <SectionLabel>
              {accounts.length === 1 ? 'Paired account' : `Paired accounts · ${accounts.length}`}
            </SectionLabel>
            {accounts.map(account => {
              const accent = themeFor(account.brand).legible;
              return (
                <Row
                  key={account.deviceId}
                  tone={accent}
                  title={account.brand.name}
                  subtitle={account.subjectLabel}
                  meta={
                    account.approvalKeyMode === 'app-gated'
                      ? `${account.deviceLabel} · no hardware lock`
                      : account.deviceLabel
                  }
                  onPress={() => onOpenAccount(account)}
                  accessibilityLabel={`${account.brand.name}, ${account.subjectLabel}. Open settings.`}
                />
              );
            })}
            <Button title="Pair another account" icon="add" onPress={onPair} />
          </>
        )}

        <Button
          title="About AgentAction"
          tone="ghost"
          icon="information-circle-outline"
          onPress={onAbout}
        />
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
});
