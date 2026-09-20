/**
 * One account's settings: what this phone is called, whether notifications
 * actually work, the approval key, and unpairing.
 *
 * The Notifications section exists because push used to fail silently. The
 * only symptom was a phone that never buzzed, and there was nowhere to look.
 * Now the three things that can be wrong — permission, token, server — each
 * have a line, and the last error is printed exactly as it was thrown.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Account } from '../lib/accounts';
import { updateAccount } from '../lib/accounts';
import { ApiError } from '../lib/api';
import { getBiometricStatus } from '../lib/keys';
import type { BiometricStatus } from '../lib/keys';
import { clientFor, unpairAccount } from '../lib/pairing';
import { getPushDiagnostics, retryPushRegistration, sendTestNotification } from '../lib/push';
import type { PushDiagnostics } from '../lib/push';
import { palette, space, themeFor, type } from '../lib/theme';
import {
  AccountHeader,
  Button,
  Card,
  Divider,
  Heading,
  LabelledInput,
  Notice,
  Screen,
  StatusLine,
} from '../components/ui';
import type { IconName } from '../components/ui';

type Busy = 'rename' | 'test' | 'unpair' | 'push' | null;

export function SettingsScreen({
  account,
  onBack,
  onChanged,
  onUnpaired,
  onAbout,
}: {
  account: Account;
  onBack: () => void;
  onChanged: () => void;
  onUnpaired: () => void;
  onAbout: () => void;
}) {
  const theme = themeFor(account.brand);
  const [label, setLabel] = useState(account.deviceLabel);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [confirmUnpair, setConfirmUnpair] = useState(false);
  const [biometrics, setBiometrics] = useState<BiometricStatus | null>(null);
  const [push, setPush] = useState<PushDiagnostics | null>(null);

  useEffect(() => {
    void getBiometricStatus().then(setBiometrics).catch(() => setBiometrics(null));
    void getPushDiagnostics().then(setPush).catch(() => setPush(null));
  }, []);

  const rename = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed || trimmed === account.deviceLabel) return;
    setBusy('rename');
    setError(null);
    setNote(null);
    try {
      await clientFor(account).updateSelf({ label: trimmed });
      await updateAccount(account.deviceId, { deviceLabel: trimmed });
      setNote('Renamed.');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not rename this phone.');
    } finally {
      setBusy(null);
    }
  }, [account, label, onChanged]);

  const test = useCallback(async () => {
    setBusy('test');
    setError(null);
    setNote(null);
    const sent = await sendTestNotification(account.brand.name);
    setPush(await getPushDiagnostics());
    setNote(
      sent
        ? 'Sent. A test notification should appear shortly.'
        : 'Nothing was sent — see the last error below.',
    );
    setBusy(null);
  }, [account]);

  const retryPush = useCallback(async () => {
    setBusy('push');
    setError(null);
    setNote(null);
    const next = await retryPushRegistration([account]);
    setPush(next);
    setNote(
      next.token
        ? `Registered with ${account.brand.name}.`
        : 'Still no push token — the reason is below.',
    );
    onChanged();
    setBusy(null);
  }, [account, onChanged]);

  const unpair = useCallback(async () => {
    setBusy('unpair');
    setError(null);
    const { serverNotified } = await unpairAccount(account);
    setBusy(null);
    if (!serverNotified) {
      // Local removal always succeeds; say so rather than imply a clean revoke.
      setNote('Removed from this phone. The server could not be reached — revoke it in the portal too.');
    }
    onUnpaired();
  }, [account, onUnpaired]);

  const permission = describePermission(push);
  const registration = describeRegistration(push, account);

  return (
    <View style={styles.flex}>
      <AccountHeader theme={theme} subtitle={account.subjectLabel} onBack={onBack} />
      <Screen>
        {note ? <Notice tone="info">{note}</Notice> : null}
        {error ? <Notice tone="deny">{error}</Notice> : null}

        <Card>
          <Heading>This phone’s name</Heading>
          <LabelledInput
            hint="Shown in the portal’s device list, so you can tell your phones apart."
            accessibilityLabel="This phone’s name"
            value={label}
            onChangeText={setLabel}
            autoCapitalize="words"
            autoCorrect={false}
            maxLength={64}
            placeholder="Avijit’s iPhone"
          />
          <Button
            title="Save name"
            theme={theme}
            busy={busy === 'rename'}
            disabled={busy !== null || !label.trim() || label.trim() === account.deviceLabel}
            onPress={rename}
          />
        </Card>

        <Card>
          <Heading>Notifications</Heading>
          <StatusLine
            label="Permission"
            value={permission.value}
            colour={permission.colour}
            icon={permission.icon}
          />
          <Divider />
          <StatusLine
            label="Push token"
            value={registration.value}
            colour={registration.colour}
            icon={registration.icon}
          />
          <Divider />
          <StatusLine
            label="Last error"
            value={
              push?.lastError
                ? `${push.lastErrorStage ?? 'push'} — ${push.lastError}`
                : 'None recorded this session.'
            }
            colour={push?.lastError ? palette.deny : palette.muted}
            icon={push?.lastError ? 'alert-circle-outline' : undefined}
          />
          <Text style={type.meta}>
            Even with push off, the Waiting tab refreshes every fifteen seconds and whenever you
            pull down on it. You will not miss a request; you will only miss the buzz.
          </Text>
          <Button
            title="Retry registration"
            icon="refresh"
            theme={theme}
            busy={busy === 'push'}
            disabled={busy !== null}
            onPress={retryPush}
          />
          <Button
            title="Send a test notification"
            icon="notifications-outline"
            busy={busy === 'test'}
            disabled={busy !== null}
            caption="Sent by this phone to itself — it does not involve the approval server."
            onPress={test}
          />
        </Card>

        <Card>
          <Heading>Approval key</Heading>
          {account.approvalKeyMode === 'keychain' ? (
            <Text style={type.body}>
              Held in this phone’s secure hardware and released only after Face ID, a fingerprint
              or your passcode.
            </Text>
          ) : (
            <Notice tone="warn">
              Stored without a hardware lock, because this phone had no biometrics or passcode set
              up when it was paired. AgentAction still asks before approving, but re-pair once a
              lock is set up to protect the key properly.
            </Notice>
          )}
          {biometrics ? (
            <Text style={type.meta}>
              {biometrics.canPrompt
                ? 'This phone can ask you to confirm.'
                : 'This phone currently has no lock to ask with.'}
            </Text>
          ) : null}
        </Card>

        <Card>
          <Heading>Unpair</Heading>
          <Text style={type.body}>
            Removes {account.brand.name} from this phone and revokes its keys. You will stop
            receiving approval requests for {account.subjectLabel}.
          </Text>
          {confirmUnpair ? (
            <>
              <Notice tone="deny">Unpair {account.brand.name}? This cannot be undone here.</Notice>
              <Button
                title="Yes, unpair"
                tone="deny"
                icon="unlink-outline"
                busy={busy === 'unpair'}
                disabled={busy !== null}
                onPress={unpair}
              />
              <Button title="Keep it" onPress={() => setConfirmUnpair(false)} disabled={busy !== null} />
            </>
          ) : (
            <Button
              title="Unpair this account"
              tone="deny"
              icon="unlink-outline"
              disabled={busy !== null}
              onPress={() => setConfirmUnpair(true)}
            />
          )}
        </Card>

        <Button
          title="About AgentAction"
          tone="ghost"
          icon="information-circle-outline"
          onPress={onAbout}
        />

        <View style={styles.footNotes}>
          <Text style={type.meta}>Paired {new Date(account.createdAt).toLocaleString()}</Text>
          <Text style={type.meta}>{account.serverUrl}</Text>
        </View>
      </Screen>
    </View>
  );
}

interface Described {
  value: string;
  colour: string;
  icon?: IconName;
}

function describePermission(push: PushDiagnostics | null): Described {
  if (!push) return { value: 'Checking…', colour: palette.muted };
  switch (push.permission) {
    case 'granted':
      return { value: 'Allowed', colour: palette.approve, icon: 'checkmark-circle' };
    case 'denied':
      return {
        value: push.canAskAgain
          ? 'Refused — Retry will ask again'
          : 'Blocked. Turn notifications on for AgentAction in your phone’s settings.',
        colour: palette.deny,
        icon: 'close-circle-outline',
      };
    case 'undetermined':
      return { value: 'Not asked yet', colour: palette.hold, icon: 'alert-circle-outline' };
    default:
      return { value: 'Could not be read', colour: palette.muted, icon: 'alert-circle-outline' };
  }
}

function describeRegistration(push: PushDiagnostics | null, account: Account): Described {
  if (!push) return { value: 'Checking…', colour: palette.muted };
  // The account holds the token the server was last told about; `push.token`
  // is what this session actually obtained. They agreeing is the whole test.
  const stored = account.pushToken ?? null;
  if (stored && (!push.token || push.token === stored)) {
    return { value: `Registered with ${account.brand.name}`, colour: palette.approve, icon: 'checkmark-circle' };
  }
  if (push.token) {
    return {
      value: 'This phone has a token, but the server has not accepted it',
      colour: palette.hold,
      icon: 'alert-circle-outline',
    };
  }
  return {
    value: 'None. This phone will not be alerted.',
    colour: palette.deny,
    icon: 'close-circle-outline',
  };
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
  footNotes: { gap: space.xs, paddingHorizontal: space.xs },
});
