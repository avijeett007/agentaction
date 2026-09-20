import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { config } from '../../src/config';
import * as push from '../../src/services/push';
import { sha256Hex } from '../../src/lib/crypto';
import { resetDb } from '../helpers/db';
import { createTenant, createDevice } from '../helpers/factories';
import { makeKeyPair } from '../helpers/keys';

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

interface PairingResponse {
  pairing: { id: string; expiresAt: string };
  qrPayload: {
    v: number;
    serverUrl: string;
    secret: string;
    tenantId: string;
    brand: { name: string; logoUrl: string | null; color: string };
    subject: { label: string };
  };
}

/** The portal's "Add a phone" call. */
async function startPairing(apiKey: string, externalId = 'cust_1', label = 'Acme Dental') {
  const res = await request(app)
    .post('/v1/pairings')
    .set('authorization', `Bearer ${apiKey}`)
    .send({ externalId, label });
  expect(res.status).toBe(201);
  return res.body as PairingResponse;
}

/** What the app posts once it has scanned the code and made its keypairs. */
function registration(secret: string, overrides: Record<string, unknown> = {}) {
  return {
    secret,
    devicePubKey: makeKeyPair().publicKey,
    approvalPubKey: makeKeyPair().publicKey,
    label: "Owner's iPhone",
    platform: 'ios',
    model: 'iPhone16,1',
    pushToken: 'ExponentPushToken[abc]',
    ...overrides,
  };
}

describe('POST /v1/pairings', () => {
  it('returns a QR payload with the brand, the subject and a single-use secret', async () => {
    const { tenant, apiKey } = await createTenant();
    const body = await startPairing(apiKey);

    expect(body.qrPayload).toMatchObject({
      v: 1,
      serverUrl: config.publicBaseUrl,
      tenantId: tenant.id,
      brand: { name: tenant.brandName, color: tenant.brandColor },
      subject: { label: 'Acme Dental' },
    });
    expect(body.qrPayload.secret).toEqual(expect.any(String));

    const stored = await prisma.pairingCode.findUnique({ where: { id: body.pairing.id } });
    expect(stored?.secretHash).toBe(sha256Hex(body.qrPayload.secret));
    // The plain secret exists only in the response above.
    expect(JSON.stringify(stored)).not.toContain(body.qrPayload.secret);
  });

  it('creates the subject on the way through and reuses it next time', async () => {
    const { tenant, apiKey } = await createTenant();
    await startPairing(apiKey, 'cust_9', 'First Label');
    await startPairing(apiKey, 'cust_9', 'Second Label');

    const subjects = await prisma.subject.findMany({ where: { tenantId: tenant.id } });
    expect(subjects).toHaveLength(1);
    expect(subjects[0].label).toBe('Second Label');
    expect(await prisma.pairingCode.count()).toBe(2);
  });

  it('expires the code after the configured pairing window', async () => {
    const { apiKey } = await createTenant();
    const body = await startPairing(apiKey);
    const ttlMs = config.pairingTtlSec * 1000;
    const remaining = new Date(body.pairing.expiresAt).getTime() - Date.now();
    expect(remaining).toBeGreaterThan(ttlMs - 10_000);
    expect(remaining).toBeLessThanOrEqual(ttlMs);
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app)
      .post('/v1/pairings')
      .send({ externalId: 'cust_1', label: 'Acme' });
    expect(res.status).toBe(401);
  });

  it('rejects a body with no externalId', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app)
      .post('/v1/pairings')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ label: 'Acme' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('POST /v1/devices/register', () => {
  it('pairs the phone and hands back the branding it should re-skin to', async () => {
    const { tenant, apiKey } = await createTenant();
    const { qrPayload } = await startPairing(apiKey);
    const body = registration(qrPayload.secret);

    const res = await request(app).post('/v1/devices/register').send(body);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      device: { id: expect.any(String), label: "Owner's iPhone" },
      subject: { label: 'Acme Dental', externalId: 'cust_1' },
      tenant: {
        brandName: tenant.brandName,
        brandLogoUrl: tenant.brandLogoUrl,
        brandColor: tenant.brandColor,
      },
    });

    const device = await prisma.device.findUnique({ where: { id: res.body.device.id } });
    expect(device).toMatchObject({
      devicePubKey: body.devicePubKey,
      approvalPubKey: body.approvalPubKey,
      platform: 'ios',
      model: 'iPhone16,1',
      pushToken: 'ExponentPushToken[abc]',
      revokedAt: null,
    });

    const audit = await prisma.auditEvent.findMany({ where: { type: 'device.paired' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].dataJson).toContain(res.body.device.id);
  });

  it('burns the secret: a second phone cannot use the same code', async () => {
    const { apiKey } = await createTenant();
    const { qrPayload } = await startPairing(apiKey);

    const first = await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/v1/devices/register')
      .send(registration(qrPayload.secret, { label: 'Attacker phone' }));

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('pairing_used');
    expect(await prisma.device.count()).toBe(1);
  });

  it('refuses an expired code', async () => {
    const { apiKey } = await createTenant();
    const { pairing, qrPayload } = await startPairing(apiKey);
    await prisma.pairingCode.update({
      where: { id: pairing.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('pairing_expired');
    expect(await prisma.device.count()).toBe(0);
  });

  it('refuses a secret it has never issued', async () => {
    const res = await request(app).post('/v1/devices/register').send(registration('not-a-real-secret'));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_pairing_code');
  });

  it('refuses once the tenant device cap is reached, without burning the code', async () => {
    const { tenant, apiKey } = await createTenant({ deviceCap: 1 });
    const { pairing, qrPayload } = await startPairing(apiKey);
    const subject = await prisma.subject.findFirstOrThrow({ where: { tenantId: tenant.id } });
    await createDevice(subject.id);

    const res = await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('device_cap_reached');
    expect(await prisma.device.count()).toBe(1);
    // The transaction rolled back, so the user can unpair and rescan.
    const stored = await prisma.pairingCode.findUnique({ where: { id: pairing.id } });
    expect(stored?.usedAt).toBeNull();
  });

  it('does not count a revoked device towards the cap', async () => {
    const { tenant, apiKey } = await createTenant({ deviceCap: 1 });
    const { qrPayload } = await startPairing(apiKey);
    const subject = await prisma.subject.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const { device } = await createDevice(subject.id);
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });

    const res = await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));

    expect(res.status).toBe(201);
    expect(await prisma.device.count({ where: { revokedAt: null } })).toBe(1);
  });

  it('refuses public keys that are not 32 raw bytes', async () => {
    const { apiKey } = await createTenant();

    const shortDeviceKey = await startPairing(apiKey, 'cust_a');
    const bad = await request(app)
      .post('/v1/devices/register')
      .send(registration(shortDeviceKey.qrPayload.secret, { devicePubKey: 'c2hvcnQ' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_public_key');

    const shortApprovalKey = await startPairing(apiKey, 'cust_b');
    const badApproval = await request(app)
      .post('/v1/devices/register')
      .send(registration(shortApprovalKey.qrPayload.secret, { approvalPubKey: 'c2hvcnQ' }));
    expect(badApproval.status).toBe(400);
    expect(badApproval.body.error.code).toBe('invalid_public_key');

    expect(await prisma.device.count()).toBe(0);
  });

  it('alerts the phones already on the account, but not the one just added', async () => {
    const { tenant, apiKey } = await createTenant();
    const { qrPayload } = await startPairing(apiKey);
    const subject = await prisma.subject.findFirstOrThrow({ where: { tenantId: tenant.id } });
    const existing = await createDevice(subject.id);
    const revoked = await createDevice(subject.id);
    await prisma.device.update({ where: { id: revoked.device.id }, data: { revokedAt: new Date() } });
    const spy = jest.spyOn(push, 'sendDeviceAddedPush');

    const res = await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));
    expect(res.status).toBe(201);

    expect(spy).toHaveBeenCalledTimes(1);
    const sentTo = spy.mock.calls[0][0].devices.map(d => d.id);
    expect(sentTo).toEqual([existing.device.id]);
    spy.mockRestore();
  });

  it('refuses a platform the app cannot be running on', async () => {
    const { apiKey } = await createTenant();
    const { qrPayload } = await startPairing(apiKey);
    const res = await request(app)
      .post('/v1/devices/register')
      .send(registration(qrPayload.secret, { platform: 'blackberry' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('GET /v1/pairings/:id', () => {
  it('moves from pending to used when the phone registers', async () => {
    const { apiKey } = await createTenant();
    const { pairing, qrPayload } = await startPairing(apiKey);

    const before = await request(app)
      .get(`/v1/pairings/${pairing.id}`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(before.status).toBe(200);
    expect(before.body.pairing).toMatchObject({ id: pairing.id, status: 'pending', usedAt: null });

    await request(app).post('/v1/devices/register').send(registration(qrPayload.secret));

    const after = await request(app)
      .get(`/v1/pairings/${pairing.id}`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(after.body.pairing.status).toBe('used');
    expect(after.body.pairing.usedAt).not.toBeNull();
  });

  it('reports a lapsed code as expired', async () => {
    const { apiKey } = await createTenant();
    const { pairing } = await startPairing(apiKey);
    await prisma.pairingCode.update({
      where: { id: pairing.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .get(`/v1/pairings/${pairing.id}`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.body.pairing.status).toBe('expired');
  });

  it('does not reveal another tenant pairing', async () => {
    const a = await createTenant();
    const b = await createTenant();
    const { pairing } = await startPairing(b.apiKey);

    const res = await request(app)
      .get(`/v1/pairings/${pairing.id}`)
      .set('authorization', `Bearer ${a.apiKey}`);
    expect(res.status).toBe(404);
  });

  it('answers 404 for an id that does not exist', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app)
      .get('/v1/pairings/pair_nope')
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
  });
});
