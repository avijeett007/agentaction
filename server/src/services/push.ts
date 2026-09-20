import { Expo, type ExpoPushMessage } from 'expo-server-sdk';
import type { Device } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { prisma } from '../prisma';

/**
 * Push delivery to paired phones, through the Expo push service (APNs + FCM).
 *
 * Contract every caller relies on:
 * - never throws: a push failure must not fail the request that triggered it;
 * - never puts tool arguments in the notification body — it shows on a lock
 *   screen. Brand, tool and code only;
 * - marks a device's token dead when the push service rejects it.
 *
 * The functions here take only display-safe values, so there is no path by
 * which the arguments of a tool call could reach a notification: they are not
 * passed in.
 *
 * Follow-up (own ticket): receipt polling. A ticket only says Expo accepted the
 * message; APNs and FCM report the real outcome minutes later, through
 * `getPushNotificationReceiptsAsync`, and that is where most
 * `DeviceNotRegistered` verdicts actually arrive. Phase 1 retires a token on
 * the errors that come back on the ticket itself and leaves the rest to the
 * portal's "not delivered" column.
 */

export interface PushOutcome {
  deviceId: string;
  ok: boolean;
  error?: string;
}

/** Everything but the recipient: one body, many phones. */
type PushBody = Omit<ExpoPushMessage, 'to'>;

/**
 * Phase 1 ships a single Android channel, registered by the app at pairing.
 * Naming a channel Android does not know silently demotes the notification to
 * the default importance, so every message uses this one.
 */
const ANDROID_CHANNEL = 'approvals';

let client: Expo | undefined;
let clientToken: string | undefined;

/**
 * One client per access token: it holds the keep-alive agent and rate limiter.
 * The token is optional — Expo accepts unauthenticated sends, and requiring one
 * would mean no notifications at all wherever it was not configured.
 */
function expoClient(accessToken: string | undefined): Expo {
  if (!client || clientToken !== accessToken) {
    client = new Expo({ accessToken });
    clientToken = accessToken;
  }
  return client;
}

/** A new approval request: goes to every live device on the subject. */
export async function sendApprovalRequestPush(input: {
  devices: Device[];
  brandName: string;
  title: string;
  code: string;
  requestId: string;
}): Promise<PushOutcome[]> {
  return deliver(
    input.devices,
    {
      title: `${input.brandName}: approval needed`,
      // The tool's one-line title and the matching code, nothing else.
      body: `${input.title} · code ${input.code}`,
      data: { type: 'approval_request', requestId: input.requestId },
      sound: 'default',
      priority: 'high',
      channelId: ANDROID_CHANNEL,
    },
    'approval_request',
  );
}

/** Someone decided: quietly clears the notification on the other phones. */
export async function sendRequestSettledPush(input: {
  devices: Device[];
  requestId: string;
  decision: 'approved' | 'denied' | 'expired';
  decidedByLabel?: string;
}): Promise<PushOutcome[]> {
  return deliver(
    input.devices,
    {
      // No title and no sound: this is an update to something the phone is
      // already showing, not a second thing to look at.
      body: settledBody(input.decision, input.decidedByLabel),
      data: { type: 'request_settled', requestId: input.requestId, decision: input.decision },
      sound: null,
      priority: 'normal',
      channelId: ANDROID_CHANNEL,
    },
    'request_settled',
  );
}

/** Security alert to existing phones when a new one is paired. */
export async function sendDeviceAddedPush(input: {
  devices: Device[];
  brandName: string;
  newDeviceLabel: string;
}): Promise<PushOutcome[]> {
  return deliver(
    input.devices,
    {
      title: `${input.brandName}: new phone added`,
      body: `${input.newDeviceLabel} can now approve actions`,
      // Worth waking the phone for: a phone the owner did not add is an incident.
      data: { type: 'device_added' },
      sound: 'default',
      priority: 'high',
      channelId: ANDROID_CHANNEL,
    },
    'device_added',
  );
}

/** Names the outcome without naming the tool — the phone already has the detail. */
function settledBody(decision: 'approved' | 'denied' | 'expired', decidedByLabel?: string): string {
  if (decision === 'expired') return 'Expired'; // nobody decided it, so no device to name
  const verb = decision === 'approved' ? 'Approved' : 'Denied';
  if (decidedByLabel) return `${verb} on ${decidedByLabel}`;
  return `Already ${decision}`;
}

/**
 * Sends one body to many phones and reports per device. Every exit is a
 * PushOutcome: callers show "not delivered" in the portal rather than treating
 * a push problem as a failure of the approval itself.
 */
async function deliver(devices: Device[], body: PushBody, kind: string): Promise<PushOutcome[]> {
  // Push is on unless someone deliberately turns it off. The access token is
  // optional at Expo — it buys enhanced security, not the ability to send — so
  // gating delivery on it meant an operator who never set it would have a
  // feature that silently notified nobody. Silence is the one failure mode this
  // product cannot afford: the whole design assumes a phone lights up.
  if (config.pushDisabled) {
    logger.debug('push skipped: EXPO_PUSH_DISABLED is set', { kind, devices: devices.length });
    return devices.map(device => ({ deviceId: device.id, ok: false, error: 'push_disabled' }));
  }
  const accessToken = config.expoAccessToken;

  const outcomes = new Map<string, PushOutcome>();
  const targets: { device: Device; token: string }[] = [];

  try {
    for (const device of devices) {
      if (device.revokedAt || !device.pushToken) {
        // Not a failure: a revoked or never-registered phone simply has nowhere
        // for the notification to go.
        outcomes.set(device.id, { deviceId: device.id, ok: false, error: 'no_token' });
        continue;
      }
      if (!Expo.isExpoPushToken(device.pushToken)) {
        // Expo would reject it on every send, so retire it now.
        outcomes.set(device.id, { deviceId: device.id, ok: false, error: 'invalid_token' });
        await retireToken(device.id, 'invalid_token');
        continue;
      }
      targets.push({ device, token: device.pushToken });
    }

    if (targets.length > 0) {
      const expo = expoClient(accessToken);
      const messages = targets.map(target => ({ ...body, to: target.token }));
      // Chunking keeps a subject with several phones down to one HTTP call.
      const chunks = expo.chunkPushNotifications(messages);

      let index = 0; // chunking preserves order, so the nth ticket is the nth target
      for (const chunk of chunks) {
        const tickets = await expo.sendPushNotificationsAsync(chunk);
        for (let i = 0; i < chunk.length; i += 1) {
          const { device } = targets[index];
          index += 1;
          const ticket = tickets[i];

          if (!ticket) {
            outcomes.set(device.id, { deviceId: device.id, ok: false, error: 'no_ticket' });
          } else if (ticket.status === 'ok') {
            outcomes.set(device.id, { deviceId: device.id, ok: true });
          } else {
            const reason = ticket.details?.error ?? ticket.message ?? 'push_error';
            outcomes.set(device.id, { deviceId: device.id, ok: false, error: reason });
            // The token belongs to an app that is gone: retire it rather than
            // push to it for ever.
            if (ticket.details?.error === 'DeviceNotRegistered') {
              await retireToken(device.id, reason);
            }
          }
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('push send failed', { kind, devices: devices.length, error: message });
    // Whatever went wrong — network, Expo outage, a malformed response — the
    // caller only needs to know these phones were not reached.
    for (const device of devices) {
      if (!outcomes.has(device.id)) {
        outcomes.set(device.id, { deviceId: device.id, ok: false, error: message });
      }
    }
  }

  return devices.map(
    device =>
      outcomes.get(device.id) ?? { deviceId: device.id, ok: false, error: 'not_sent' },
  );
}

/** Clears a dead token so it is not retried for ever. Never throws. */
async function retireToken(deviceId: string, reason: string): Promise<void> {
  try {
    await prisma.device.update({
      where: { id: deviceId },
      data: { pushToken: null, pushFailedAt: new Date() },
    });
    logger.info('push token retired', { deviceId, reason });
  } catch (err) {
    logger.warn('could not retire a dead push token', {
      deviceId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
