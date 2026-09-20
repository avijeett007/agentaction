import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject, createDevice } from '../helpers/factories';
import { deviceHeaders, makeKeyPair } from '../helpers/keys';

const app = createApp();

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** A tenant with one subject and one paired phone — the usual starting point. */
async function pairedAccount(overrides: { deviceCap?: number } = {}) {
  const { tenant, apiKey } = await createTenant(overrides);
  const subject = await createSubject(tenant.id, 'cust_1');
  const { device, deviceKeys } = await createDevice(subject.id);
  return { tenant, apiKey, subject, device, deviceKeys };
}

describe('GET /v1/devices', () => {
  it('lists the live devices of one subject', async () => {
    const { apiKey, subject, device } = await pairedAccount();
    const second = await createDevice(subject.id);

    const res = await request(app)
      .get('/v1/devices')
      .query({ externalId: 'cust_1' })
      .set('authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(2);
    expect(res.body.devices.map((d: { id: string }) => d.id).sort()).toEqual(
      [device.id, second.device.id].sort(),
    );
    expect(res.body.devices[0]).toEqual({
      id: expect.any(String),
      label: "Owner's iPhone",
      platform: 'ios',
      model: 'iPhone16,1',
      lastSeenAt: null,
      createdAt: expect.any(String),
      pushEnabled: true,
    });
    // The push token itself is server-side only.
    expect(JSON.stringify(res.body)).not.toContain('ExponentPushToken');
  });

  it('hides revoked devices', async () => {
    const { apiKey, device } = await pairedAccount();
    await prisma.device.update({
      where: { id: device.id },
      data: { revokedAt: new Date(), pushToken: null },
    });

    const res = await request(app)
      .get('/v1/devices')
      .query({ externalId: 'cust_1' })
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual([]);
  });

  it('answers 404 for a subject this tenant does not have', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createSubject(b.tenant.id, 'cust_other');

    const unknown = await request(app)
      .get('/v1/devices')
      .query({ externalId: 'cust_nope' })
      .set('authorization', `Bearer ${a.apiKey}`);
    expect(unknown.status).toBe(404);

    const crossTenant = await request(app)
      .get('/v1/devices')
      .query({ externalId: 'cust_other' })
      .set('authorization', `Bearer ${a.apiKey}`);
    expect(crossTenant.status).toBe(404);
  });

  it('rejects a call with no externalId', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app).get('/v1/devices').set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });

  it('refuses an unauthenticated caller', async () => {
    const res = await request(app).get('/v1/devices').query({ externalId: 'cust_1' });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /v1/devices/:id', () => {
  it('revokes the phone and clears its push token', async () => {
    const { apiKey, device } = await pairedAccount();

    const res = await request(app)
      .delete(`/v1/devices/${device.id}`)
      .set('authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.device.id).toBe(device.id);
    const stored = await prisma.device.findUnique({ where: { id: device.id } });
    expect(stored?.revokedAt).not.toBeNull();
    expect(stored?.pushToken).toBeNull();
  });

  it('is idempotent and keeps the first revocation time', async () => {
    const { apiKey, device } = await pairedAccount();

    const first = await request(app)
      .delete(`/v1/devices/${device.id}`)
      .set('authorization', `Bearer ${apiKey}`);
    const second = await request(app)
      .delete(`/v1/devices/${device.id}`)
      .set('authorization', `Bearer ${apiKey}`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.device.revokedAt).toBe(first.body.device.revokedAt);
    // Only the revocation that changed something is worth an audit line.
    expect(await prisma.auditEvent.count({ where: { type: 'device.revoked' } })).toBe(1);
  });

  it('does not let one tenant revoke another tenant device', async () => {
    const attacker = await createTenant();
    const { device } = await pairedAccount();

    const res = await request(app)
      .delete(`/v1/devices/${device.id}`)
      .set('authorization', `Bearer ${attacker.apiKey}`);

    expect(res.status).toBe(404);
    const stored = await prisma.device.findUnique({ where: { id: device.id } });
    expect(stored?.revokedAt).toBeNull();
  });

  it('answers 404 for a device id that does not exist', async () => {
    const { apiKey } = await pairedAccount();
    const res = await request(app)
      .delete('/v1/devices/dev_nope')
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /v1/devices/me', () => {
  it('renames the phone and refreshes its push token', async () => {
    const { device, deviceKeys } = await pairedAccount();
    await prisma.device.update({
      where: { id: device.id },
      data: { pushFailedAt: new Date() },
    });
    const body = { label: 'Work phone', pushToken: 'ExponentPushToken[fresh]' };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ id: device.id, label: 'Work phone', pushEnabled: true });
    const stored = await prisma.device.findUnique({ where: { id: device.id } });
    expect(stored?.label).toBe('Work phone');
    expect(stored?.pushToken).toBe('ExponentPushToken[fresh]');
    // A token we have just been handed is presumed live again.
    expect(stored?.pushFailedAt).toBeNull();
  });

  it('clears the push token when the user turns notifications off', async () => {
    const { device, deviceKeys } = await pairedAccount();
    const body = { pushToken: null };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', body))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.device.pushEnabled).toBe(false);
    const stored = await prisma.device.findUnique({ where: { id: device.id } });
    expect(stored?.pushToken).toBeNull();
    expect(stored?.label).toBe("Owner's iPhone");
  });

  it('rejects an empty label', async () => {
    const { device, deviceKeys } = await pairedAccount();
    const body = { label: '' };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', body))
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('DELETE /v1/devices/me', () => {
  it('unpairs the phone from its own Settings screen', async () => {
    const { apiKey, device, deviceKeys } = await pairedAccount();

    const res = await request(app)
      .delete('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'DELETE', '/v1/devices/me'));

    expect(res.status).toBe(200);
    expect(res.body.device.revokedAt).toEqual(expect.any(String));

    const list = await request(app)
      .get('/v1/devices')
      .query({ externalId: 'cust_1' })
      .set('authorization', `Bearer ${apiKey}`);
    expect(list.body.devices).toEqual([]);
  });

  it('leaves the phone unable to call again', async () => {
    const { device, deviceKeys } = await pairedAccount();
    await request(app)
      .delete('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'DELETE', '/v1/devices/me'));

    const again = await request(app)
      .delete('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'DELETE', '/v1/devices/me'));
    expect(again.status).toBe(401);
  });
});

describe('device authentication', () => {
  it('refuses a call with no signature headers', async () => {
    const { device } = await pairedAccount();
    const res = await request(app).patch('/v1/devices/me').send({ label: 'x' });
    expect(res.status).toBe(401);
    const stored = await prisma.device.findUnique({ where: { id: device.id } });
    expect(stored?.label).toBe("Owner's iPhone");
  });

  it('refuses a signature made by a different key', async () => {
    const { device } = await pairedAccount();
    const body = { label: 'Stolen' };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, makeKeyPair(), 'PATCH', '/v1/devices/me', body))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
  });

  it('refuses a signature over a different body', async () => {
    const { device, deviceKeys } = await pairedAccount();
    const signed = { label: 'Innocent' };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', signed))
      .send({ label: 'Tampered' });

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
  });

  it('refuses a stale timestamp, so an old call cannot be replayed', async () => {
    const { device, deviceKeys } = await pairedAccount();
    const body = { label: 'Replay' };
    const longAgo = Math.floor(Date.now() / 1000) - 10_000;

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', body, longAgo))
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('stale_signature');
  });

  it('refuses a revoked device even with a valid signature', async () => {
    const { device, deviceKeys } = await pairedAccount();
    await prisma.device.update({ where: { id: device.id }, data: { revokedAt: new Date() } });
    const body = { label: 'Back in' };

    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders(device.id, deviceKeys, 'PATCH', '/v1/devices/me', body))
      .send(body);

    expect(res.status).toBe(401);
  });

  it('refuses an unknown device id', async () => {
    const keys = makeKeyPair();
    const body = { label: 'Ghost' };
    const res = await request(app)
      .patch('/v1/devices/me')
      .set(deviceHeaders('dev_nope', keys, 'PATCH', '/v1/devices/me', body))
      .send(body);
    expect(res.status).toBe(401);
  });
});
