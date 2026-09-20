import type { Device } from '@prisma/client';
import { prisma } from '../../src/prisma';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject, createDevice } from '../helpers/factories';

/**
 * The Expo SDK is replaced wholesale, so no test can reach the push service.
 * The doubles are created inside the factory and handed back on the module, so
 * a module registry reset (see loadPush) hands out fresh ones with it.
 */
jest.mock('expo-server-sdk', () => {
  const sendPushNotificationsAsync = jest.fn(async (messages: unknown[]) =>
    messages.map((_m, i) => ({ status: 'ok', id: `receipt_${i}` })),
  );
  const chunkPushNotifications = jest.fn((messages: unknown[]) =>
    messages.length > 0 ? [messages] : [],
  );
  const isExpoPushToken = jest.fn(
    (token: unknown) => typeof token === 'string' && /^ExponentPushToken\[.+\]$/.test(token),
  );

  class MockExpo {
    static isExpoPushToken = isExpoPushToken;
    chunkPushNotifications = chunkPushNotifications;
    sendPushNotificationsAsync = sendPushNotificationsAsync;
    constructor(_options?: unknown) {}
  }

  return {
    __esModule: true,
    Expo: MockExpo,
    default: MockExpo,
    __mocks: { sendPushNotificationsAsync, chunkPushNotifications, isExpoPushToken },
  };
});

type ExpoMocks = {
  sendPushNotificationsAsync: jest.Mock;
  chunkPushNotifications: jest.Mock;
  isExpoPushToken: jest.Mock;
};
type PushModule = typeof import('../../src/services/push');

/**
 * config.ts reads the environment once, at import time, so the only honest way
 * to exercise both halves of the switch is to load the service afresh with the
 * environment we want. Both variables are put back immediately — config has
 * already captured them — so no test leaks its setting into the next.
 *
 * Note push is ON unless EXPO_PUSH_DISABLED says otherwise: an access token is
 * optional at Expo, and gating delivery on it once meant a deployment that
 * forgot it notified nobody, silently.
 */
function loadPush(
  accessToken?: string,
  { disabled = false }: { disabled?: boolean } = {},
): { push: PushModule; mocks: ExpoMocks } {
  const previous = process.env.EXPO_ACCESS_TOKEN;
  const previousDisabled = process.env.EXPO_PUSH_DISABLED;
  if (accessToken) process.env.EXPO_ACCESS_TOKEN = accessToken;
  else delete process.env.EXPO_ACCESS_TOKEN;
  if (disabled) process.env.EXPO_PUSH_DISABLED = 'true';
  else delete process.env.EXPO_PUSH_DISABLED;

  let push!: PushModule;
  let mocks!: ExpoMocks;
  jest.isolateModules(() => {
    push = require('../../src/services/push') as PushModule;
    mocks = (require('expo-server-sdk') as { __mocks: ExpoMocks }).__mocks;
  });

  if (previous === undefined) delete process.env.EXPO_ACCESS_TOKEN;
  else process.env.EXPO_ACCESS_TOKEN = previous;
  if (previousDisabled === undefined) delete process.env.EXPO_PUSH_DISABLED;
  else process.env.EXPO_PUSH_DISABLED = previousDisabled;
  return { push, mocks };
}

let push: PushModule;
let mocks: ExpoMocks;
let subjectId: string;

/** A device row with the push token we want to test against. */
async function device(pushToken: string | null, overrides: Partial<Device> = {}): Promise<Device> {
  const { device: created } = await createDevice(subjectId);
  return prisma.device.update({
    where: { id: created.id },
    data: { pushToken, ...overrides },
  });
}

beforeEach(async () => {
  await resetDb();
  const { tenant } = await createTenant();
  subjectId = (await createSubject(tenant.id)).id;
  ({ push, mocks } = loadPush('expo-test-access-token'));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('sendApprovalRequestPush', () => {
  it('reaches every phone on the subject in one chunked call', async () => {
    const phones = [
      await device('ExponentPushToken[owner-iphone]'),
      await device('ExponentPushToken[managers-pixel]'),
    ];

    const outcomes = await push.sendApprovalRequestPush({
      devices: phones,
      brandName: 'Acme',
      title: 'Send an email to 240 contacts',
      code: '4821',
      requestId: 'req_1',
    });

    expect(outcomes).toEqual([
      { deviceId: phones[0].id, ok: true },
      { deviceId: phones[1].id, ok: true },
    ]);
    expect(mocks.chunkPushNotifications).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushNotificationsAsync).toHaveBeenCalledTimes(1);
    expect(mocks.sendPushNotificationsAsync.mock.calls[0][0]).toHaveLength(2);
  });

  it('carries the brand, the tool title and the code, and nothing else', async () => {
    const phone = await device('ExponentPushToken[owner-iphone]');
    // The real arguments of the gated call live on the request row. The push
    // signature has no way to reach them; this proves the payload cannot carry
    // them even when they exist alongside.
    await prisma.approvalRequest.create({
      data: {
        id: 'req_secret',
        subjectId,
        actorLabel: 'Claude Code',
        resourceKey: 'gmail/GMAIL_SEND_EMAIL',
        title: 'Send an email to 240 contacts',
        fieldsJson: JSON.stringify([{ label: 'Body', value: 'SECRET-BODY-TEXT' }]),
        argsHash: 'a'.repeat(64),
        code: '4821',
        expiresAt: new Date(Date.now() + 600_000),
      },
    });

    await push.sendApprovalRequestPush({
      devices: [phone],
      brandName: 'Acme',
      title: 'Send an email to 240 contacts',
      code: '4821',
      requestId: 'req_secret',
    });

    const [messages] = mocks.sendPushNotificationsAsync.mock.calls[0];
    expect(Object.keys(messages[0]).sort()).toEqual([
      'body',
      'channelId',
      'data',
      'priority',
      'sound',
      'title',
      'to',
    ]);
    expect(messages[0]).toMatchObject({
      to: 'ExponentPushToken[owner-iphone]',
      title: 'Acme: approval needed',
      body: 'Send an email to 240 contacts · code 4821',
      data: { type: 'approval_request', requestId: 'req_secret' },
      sound: 'default',
      priority: 'high',
      channelId: 'approvals',
    });
    expect(Object.keys(messages[0].data).sort()).toEqual(['requestId', 'type']);
    expect(JSON.stringify(messages)).not.toContain('SECRET-BODY-TEXT');
  });

  it('reports a phone with no token, and a revoked one, as undelivered', async () => {
    const silent = await device(null);
    const revoked = await device('ExponentPushToken[old-phone]', { revokedAt: new Date() });

    const outcomes = await push.sendApprovalRequestPush({
      devices: [silent, revoked],
      brandName: 'Acme',
      title: 'Delete a customer',
      code: '1111',
      requestId: 'req_2',
    });

    expect(outcomes).toEqual([
      { deviceId: silent.id, ok: false, error: 'no_token' },
      { deviceId: revoked.id, ok: false, error: 'no_token' },
    ]);
    expect(mocks.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('retires a token Expo would not accept at all', async () => {
    const phone = await device('not-an-expo-token');

    const outcomes = await push.sendApprovalRequestPush({
      devices: [phone],
      brandName: 'Acme',
      title: 'Pay an invoice',
      code: '2222',
      requestId: 'req_3',
    });

    expect(outcomes).toEqual([{ deviceId: phone.id, ok: false, error: 'invalid_token' }]);
    expect(mocks.sendPushNotificationsAsync).not.toHaveBeenCalled();

    const stored = await prisma.device.findUnique({ where: { id: phone.id } });
    expect(stored?.pushToken).toBeNull();
    expect(stored?.pushFailedAt).toBeInstanceOf(Date);
  });

  it('retires a token the push service reports as unregistered', async () => {
    const dead = await device('ExponentPushToken[uninstalled]');
    const live = await device('ExponentPushToken[owner-iphone]');
    mocks.sendPushNotificationsAsync.mockImplementation(async () => [
      {
        status: 'error',
        message: '"ExponentPushToken[uninstalled]" is not a registered push notification recipient',
        details: { error: 'DeviceNotRegistered' },
      },
      { status: 'ok', id: 'receipt_1' },
    ]);

    const outcomes = await push.sendApprovalRequestPush({
      devices: [dead, live],
      brandName: 'Acme',
      title: 'Send an email',
      code: '3333',
      requestId: 'req_4',
    });

    expect(outcomes).toEqual([
      { deviceId: dead.id, ok: false, error: 'DeviceNotRegistered' },
      { deviceId: live.id, ok: true },
    ]);

    const retired = await prisma.device.findUnique({ where: { id: dead.id } });
    expect(retired?.pushToken).toBeNull();
    expect(retired?.pushFailedAt).toBeInstanceOf(Date);
    // The healthy phone alongside it is left exactly as it was.
    const untouched = await prisma.device.findUnique({ where: { id: live.id } });
    expect(untouched?.pushToken).toBe('ExponentPushToken[owner-iphone]');
    expect(untouched?.pushFailedAt).toBeNull();
  });

  it('sends nothing when EXPO_PUSH_DISABLED is set', async () => {
    const disabled = loadPush(undefined, { disabled: true });
    const phone = await device('ExponentPushToken[owner-iphone]');

    const outcomes = await disabled.push.sendApprovalRequestPush({
      devices: [phone],
      brandName: 'Acme',
      title: 'Send an email',
      code: '4444',
      requestId: 'req_5',
    });

    expect(outcomes).toEqual([{ deviceId: phone.id, ok: false, error: 'push_disabled' }]);
    expect(disabled.mocks.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('still sends when no access token is configured — the token is optional at Expo', async () => {
    // This is the regression that matters: gating delivery on the token once
    // meant an operator who never set it had approvals nobody was told about.
    const noToken = loadPush(undefined);
    noToken.mocks.chunkPushNotifications.mockImplementation((m: unknown[]) => [m]);
    noToken.mocks.sendPushNotificationsAsync.mockResolvedValue([{ status: 'ok', id: 'r1' }]);
    const phone = await device('ExponentPushToken[owner-iphone]');

    const outcomes = await noToken.push.sendApprovalRequestPush({
      devices: [phone],
      brandName: 'Acme',
      title: 'Send an email',
      code: '4444',
      requestId: 'req_6',
    });

    expect(outcomes).toEqual([{ deviceId: phone.id, ok: true }]);
    expect(noToken.mocks.sendPushNotificationsAsync).toHaveBeenCalled();
  });

  it('swallows an unexpected SDK failure and reports it per device', async () => {
    const phones = [
      await device('ExponentPushToken[owner-iphone]'),
      await device('ExponentPushToken[managers-pixel]'),
    ];
    mocks.sendPushNotificationsAsync.mockRejectedValue(new Error('Expo is down'));

    const outcomes = await push.sendApprovalRequestPush({
      devices: phones,
      brandName: 'Acme',
      title: 'Send an email',
      code: '5555',
      requestId: 'req_6',
    });

    expect(outcomes).toEqual([
      { deviceId: phones[0].id, ok: false, error: 'Expo is down' },
      { deviceId: phones[1].id, ok: false, error: 'Expo is down' },
    ]);
    // A live token is not retired over an outage — only Expo's own verdict does that.
    const stored = await prisma.device.findUnique({ where: { id: phones[0].id } });
    expect(stored?.pushToken).toBe('ExponentPushToken[owner-iphone]');
  });
});

describe('sendRequestSettledPush', () => {
  it('names the phone that decided, quietly', async () => {
    const phone = await device('ExponentPushToken[owner-iphone]');

    const outcomes = await push.sendRequestSettledPush({
      devices: [phone],
      requestId: 'req_7',
      decision: 'approved',
      decidedByLabel: "Sarah's Pixel",
    });

    expect(outcomes).toEqual([{ deviceId: phone.id, ok: true }]);
    const [messages] = mocks.sendPushNotificationsAsync.mock.calls[0];
    expect(messages[0]).toMatchObject({
      body: "Approved on Sarah's Pixel",
      data: { type: 'request_settled', requestId: 'req_7', decision: 'approved' },
      sound: null,
      priority: 'normal',
    });
    // No title and no sound: it only clears what the phone is already showing.
    expect(Object.keys(messages[0])).not.toContain('title');
  });

  it('falls back to the outcome alone when no device decided it', async () => {
    const phone = await device('ExponentPushToken[owner-iphone]');

    for (const [decision, body] of [
      ['approved', 'Already approved'],
      ['denied', 'Already denied'],
      ['expired', 'Expired'],
    ] as const) {
      mocks.sendPushNotificationsAsync.mockClear();
      await push.sendRequestSettledPush({ devices: [phone], requestId: 'req_8', decision });
      const [messages] = mocks.sendPushNotificationsAsync.mock.calls[0];
      expect(messages[0].body).toBe(body);
      expect(messages[0].data.decision).toBe(decision);
    }
  });
});

describe('sendDeviceAddedPush', () => {
  it('alerts the phones that were already paired', async () => {
    const phone = await device('ExponentPushToken[owner-iphone]');

    const outcomes = await push.sendDeviceAddedPush({
      devices: [phone],
      brandName: 'Acme',
      newDeviceLabel: "Sarah's Pixel",
    });

    expect(outcomes).toEqual([{ deviceId: phone.id, ok: true }]);
    const [messages] = mocks.sendPushNotificationsAsync.mock.calls[0];
    expect(messages[0]).toMatchObject({
      title: 'Acme: new phone added',
      body: "Sarah's Pixel can now approve actions",
      data: { type: 'device_added' },
      sound: 'default',
      priority: 'high',
    });
  });
});
