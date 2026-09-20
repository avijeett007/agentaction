/**
 * Push notifications.
 *
 * The notification itself never carries arguments — only the brand, the tool
 * and the four-digit code — so a glance at a locked screen leaks nothing. It
 * carries the ids needed to open the right request in the right account.
 *
 * Every failure here used to be swallowed, on the reasonable grounds that the
 * pending list still works by polling. The unreasonable consequence was that a
 * phone which never buzzed gave the owner nothing to look at: no permission
 * state, no token, no error. So the failures are still non-fatal, but they are
 * now *recorded* and Settings reads them back verbatim.
 */
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Account } from './accounts';
import { updateAccount } from './accounts';
import { clientFor } from './pairing';

export interface RequestTarget {
  deviceId: string;
  requestId: string;
}

export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unknown';

export interface PushDiagnostics {
  permission: PushPermission;
  /** False means the OS will not prompt again — only Settings can undo it. */
  canAskAgain: boolean;
  /** The Expo token this app session holds, or null if it never got one. */
  token: string | null;
  /** The last thing that went wrong, exactly as it was thrown. */
  lastError: string | null;
  /** Where that error happened, so "permission" and "server" are separable. */
  lastErrorStage: string | null;
  checkedAt: string;
}

/**
 * Session state. Deliberately not persisted: a stale error from three days ago
 * is worse than no error, and the app re-registers at every cold start anyway,
 * so a real problem reappears within a second of opening the app.
 */
let lastToken: string | null = null;
let lastError: string | null = null;
let lastErrorStage: string | null = null;

function describe(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function recordError(stage: string, err: unknown): void {
  lastError = describe(err);
  lastErrorStage = stage;
}

function clearError(): void {
  lastError = null;
  lastErrorStage = null;
}

/** Show approval pushes even while the app is open — they are the whole point. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: true,
    }),
  });
}

export async function ensurePushPermission(): Promise<boolean> {
  try {
    const existing = await Notifications.getPermissionsAsync();
    if (existing.granted) return true;
    if (!existing.canAskAgain) {
      recordError('permission', 'Notifications are blocked for AgentAction in this phone’s settings.');
      return false;
    }
    const asked = await Notifications.requestPermissionsAsync();
    if (!asked.granted) recordError('permission', 'Notification permission was not granted.');
    return asked.granted;
  } catch (err) {
    recordError('permission', err);
    return false;
  }
}

function projectId(): string | undefined {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? (Constants as { easConfig?: { projectId?: string } }).easConfig?.projectId;
}

/**
 * Returns the Expo push token, or null when we cannot have one — no
 * permission, a simulator, or no EAS project configured yet. Null is normal
 * and must not break pairing: the pending list still works by polling.
 */
export async function getExpoPushToken(): Promise<string | null> {
  if (!(await ensurePushPermission())) return null;

  if (Platform.OS === 'android') {
    try {
      await Notifications.setNotificationChannelAsync('approvals', {
        name: 'Approval requests',
        importance: Notifications.AndroidImportance.MAX,
        sound: 'default',
      });
    } catch (err) {
      // A missing channel only costs the alert its priority, so carry on and
      // still try for a token.
      recordError('android channel', err);
    }
  }

  try {
    const id = projectId();
    if (!id) {
      recordError('token', 'No EAS project id in app.json, so Expo cannot issue a push token.');
      return null;
    }
    const token = await Notifications.getExpoPushTokenAsync({ projectId: id });
    lastToken = token.data;
    clearError();
    return token.data;
  } catch (err) {
    recordError('token', err);
    return null;
  }
}

/**
 * Hands the current token to every account that has an older one. Expo rotates
 * tokens, so this runs at every cold start, not just at pairing.
 *
 * `force` re-sends even an unchanged token: that is what the Retry button in
 * Settings is for, when the server has lost it but the phone has not.
 */
export async function syncPushToken(
  accounts: Account[],
  options: { force?: boolean } = {},
): Promise<string | null> {
  const token = await getExpoPushToken();
  if (!token) return null;

  for (const account of accounts) {
    if (!options.force && account.pushToken === token) continue;
    try {
      await clientFor(account).updateSelf({ pushToken: token });
      await updateAccount(account.deviceId, { pushToken: token });
    } catch (err) {
      // Offline or revoked; the next start tries again — but say so, because
      // this is the case where the phone has a token and still never buzzes.
      recordError(`server (${account.brand.name})`, err);
    }
  }
  return token;
}

/** Everything Settings needs to explain a phone that is not buzzing. */
export async function getPushDiagnostics(): Promise<PushDiagnostics> {
  let permission: PushPermission = 'unknown';
  let canAskAgain = false;
  try {
    const current = await Notifications.getPermissionsAsync();
    canAskAgain = current.canAskAgain;
    permission = current.granted
      ? 'granted'
      : current.status === 'denied' || current.status === 'undetermined'
        ? current.status
        : 'denied';
  } catch (err) {
    recordError('permission', err);
  }

  return {
    permission,
    canAskAgain,
    token: lastToken,
    lastError,
    lastErrorStage,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Settings → Retry. Asks for permission again, gets a fresh token and pushes
 * it to the server whether or not it changed, then reports what happened.
 */
export async function retryPushRegistration(accounts: Account[]): Promise<PushDiagnostics> {
  clearError();
  lastToken = null;
  await syncPushToken(accounts, { force: true });
  return getPushDiagnostics();
}

function targetFrom(response: Notifications.NotificationResponse | null): RequestTarget | null {
  const data = response?.notification?.request?.content?.data as
    | { deviceId?: string; requestId?: string }
    | undefined;
  if (!data?.deviceId || !data?.requestId) return null;
  return { deviceId: data.deviceId, requestId: data.requestId };
}

/** Fires when the owner taps a notification while the app is running. */
export function addRequestOpenListener(onOpen: (target: RequestTarget) => void): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const target = targetFrom(response);
    if (target) onOpen(target);
  });
  return () => sub.remove();
}

/** The notification that cold-started the app, if any. */
export async function getInitialRequestTarget(): Promise<RequestTarget | null> {
  return targetFrom(await Notifications.getLastNotificationResponseAsync());
}

/**
 * Settings → "send a test notification". Deliberately a *local* notification:
 * it proves this phone will show and sound an approval alert without asking
 * the server to spend a real push on it.
 */
export async function sendTestNotification(brandName: string): Promise<boolean> {
  if (!(await ensurePushPermission())) return false;
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${brandName} · test`,
        body: 'Approval alerts look like this. No action is waiting.',
        data: { test: true },
      },
      trigger: null,
    });
    return true;
  } catch (err) {
    recordError('test notification', err);
    return false;
  }
}

/** For tests and for a clean slate when the owner retries. */
export const __push = {
  reset() {
    lastToken = null;
    clearError();
  },
};
