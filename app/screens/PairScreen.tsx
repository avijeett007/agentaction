/**
 * Pairing: scan the portal's QR code, confirm who you are connecting as, prove
 * it is you, register.
 *
 * The confirm step exists because a QR code is something a passer-by can hold
 * up. The owner must read the brand and the account out loud to themselves
 * before any key is registered anywhere — which is also why the agency's
 * colour only appears at that step, never while the camera is still hunting.
 */
import { useCallback, useState } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StyleSheet, Text, View } from 'react-native';
import type { Account } from '../lib/accounts';
import { BiometricRefusedError, promptOwner } from '../lib/keys';
import { completePairing, defaultDeviceLabel, parsePairingPayload } from '../lib/pairing';
import type { PairingPayload } from '../lib/pairing';
import { getExpoPushToken } from '../lib/push';
import { palette, radius, space, themeFor, type } from '../lib/theme';
import {
  AccountHeader,
  AppHeader,
  Button,
  Card,
  Heading,
  LabelledInput,
  Notice,
  Screen,
  StatusLine,
  useScreenInsets,
} from '../components/ui';

type Stage =
  | { name: 'scanning' }
  /** The portal prints the same string under the QR code, so it can be typed or
   *  pasted when the camera is refused, unavailable, or simply will not focus. */
  | { name: 'typing' }
  | { name: 'confirming'; payload: PairingPayload }
  | { name: 'registering'; payload: PairingPayload };

export function PairScreen({
  onPaired,
  onCancel,
}: {
  onPaired: (account: Account) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const [stage, setStage] = useState<Stage>({ name: 'scanning' });
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const insets = useScreenInsets();

  const submitTyped = useCallback(() => {
    setError(null);
    try {
      setStage({ name: 'confirming', payload: parsePairingPayload(typed.trim()) });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That code could not be read.');
    }
  }, [typed]);

  const onScanned = useCallback(({ data }: { data: string }) => {
    // The camera fires continuously; ignore everything once we have a code.
    setStage(current => {
      if (current.name !== 'scanning') return current;
      try {
        return { name: 'confirming', payload: parsePairingPayload(data) };
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That code could not be read.');
        return current;
      }
    });
  }, []);

  const confirm = useCallback(async () => {
    if (stage.name !== 'confirming') return;
    const payload = stage.payload;
    setError(null);
    setStage({ name: 'registering', payload });
    try {
      await promptOwner(`Connect to ${payload.brand.name}?`);
      const pushToken = await getExpoPushToken();
      const account = await completePairing({
        payload,
        label: defaultDeviceLabel(),
        pushToken,
      });
      onPaired(account);
    } catch (err) {
      setError(
        err instanceof BiometricRefusedError
          ? 'Pairing needs your fingerprint or Face ID to finish.'
          : err instanceof Error
            ? err.message
            : 'Pairing failed.',
      );
      setStage({ name: 'confirming', payload });
    }
  }, [stage, onPaired]);

  if (!permission) return <View style={styles.flex} />;

  if (!permission.granted) {
    return (
      <View style={styles.flex}>
        <AppHeader subtitle="Pair a phone" onBack={onCancel} />
        <Screen>
          <Card>
            <Heading>Camera access</Heading>
            <Text style={type.body}>
              AgentAction needs the camera to read the pairing code in your portal. It is used for
              nothing else, and no image ever leaves this phone.
            </Text>
            <Button
              title="Allow the camera"
              tone="primary"
              icon="camera-outline"
              onPress={requestPermission}
            />
            <Button
              title="Enter the code instead"
              icon="clipboard-outline"
              onPress={() => setStage({ name: 'typing' })}
            />
          </Card>
        </Screen>
      </View>
    );
  }

  if (stage.name === 'typing') {
    return (
      <View style={styles.flex}>
        <AppHeader subtitle="Enter the pairing code" onBack={onCancel} />
        <Screen>
          <Card>
            <Heading>Paste the code</Heading>
            <Text style={type.body}>
              In your portal, under Approvals → Add a phone, the same code is printed beneath the
              square image with a copy button.
            </Text>
            <LabelledInput
              accessibilityLabel="Pairing code"
              value={typed}
              onChangeText={setTyped}
              placeholder="Paste the pairing code"
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
              style={styles.codeInput}
            />
            {error ? <Notice tone="deny">{error}</Notice> : null}
            <Button
              title="Continue"
              tone="primary"
              disabled={typed.trim().length === 0}
              onPress={submitTyped}
            />
            <Button
              title="Use the camera"
              tone="ghost"
              icon="camera-outline"
              onPress={() => {
                setError(null);
                setStage({ name: 'scanning' });
              }}
            />
          </Card>
        </Screen>
      </View>
    );
  }

  if (stage.name === 'scanning') {
    return (
      <View style={styles.flex}>
        <AppHeader subtitle="Scan the pairing code" onBack={onCancel} />
        <View style={styles.cameraWrap}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
          {/* Four corners rather than a full frame: they say where to aim
              without covering the code the camera is trying to read. */}
          <View style={styles.reticle} pointerEvents="none">
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
        </View>
        <View
          style={[
            styles.scanFooter,
            {
              paddingBottom: Math.max(insets.bottom, space.md) + space.md,
              paddingLeft: space.xl + insets.left,
              paddingRight: space.xl + insets.right,
            },
          ]}
        >
          {error ? <Notice tone="deny">{error}</Notice> : null}
          <Text style={type.meta}>
            Open Approvals → Add a phone in your portal and hold the code inside the corners.
          </Text>
          <Button
            title="Enter the code instead"
            icon="clipboard-outline"
            onPress={() => {
              setError(null);
              setStage({ name: 'typing' });
            }}
          />
        </View>
      </View>
    );
  }

  const { payload } = stage;
  const theme = themeFor(payload.brand);
  const registering = stage.name === 'registering';

  return (
    <View style={styles.flex}>
      <AccountHeader theme={theme} subtitle="Confirm this pairing" onBack={onCancel} />
      <Screen>
        <Card>
          <Text style={type.title}>
            Connect to {payload.brand.name} as {payload.subject.label}?
          </Text>
          <Text style={type.body}>
            This phone will be asked to approve actions that {payload.brand.name}’s AI agents take
            on that account. Read both names back before you continue — a QR code is something
            anyone can print.
          </Text>
        </Card>

        <Card>
          <StatusLine label="Account" value={payload.subject.label} />
          <StatusLine label="Server" value={payload.serverUrl} />
          <StatusLine label="This phone" value={defaultDeviceLabel()} />
        </Card>

        {error ? <Notice tone="deny">{error}</Notice> : null}

        <Button
          title="Connect"
          tone="primary"
          icon="link-outline"
          theme={theme}
          busy={registering}
          onPress={confirm}
        />
        <Button title="Cancel" tone="ghost" onPress={onCancel} disabled={registering} />
      </Screen>
    </View>
  );
}

const CORNER = 34;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
  cameraWrap: {
    flex: 1,
    margin: space.xl,
    borderRadius: radius.hero,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  reticle: {
    position: 'absolute',
    top: '18%',
    bottom: '18%',
    left: '12%',
    right: '12%',
  },
  corner: { position: 'absolute', width: CORNER, height: CORNER, borderColor: palette.brand },
  cornerTL: { top: 0, left: 0, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderTopLeftRadius: 8 },
  cornerTR: { top: 0, right: 0, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderTopRightRadius: 8 },
  cornerBL: { bottom: 0, left: 0, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH, borderBottomLeftRadius: 8 },
  cornerBR: { bottom: 0, right: 0, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH, borderBottomRightRadius: 8 },
  scanFooter: {
    paddingTop: space.lg,
    gap: space.md,
    backgroundColor: palette.ink,
  },
  codeInput: { minHeight: 104, fontSize: 13, fontFamily: 'Courier', paddingTop: space.md },
});
