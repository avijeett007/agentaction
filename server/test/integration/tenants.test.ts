import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { sha256Hex } from '../../src/lib/crypto';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject } from '../helpers/factories';

const app = createApp();
const ADMIN_KEY = 'admin-test-key';

beforeEach(async () => {
  await resetDb();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /v1/tenants', () => {
  const body = { name: 'Acme Agency', brandName: 'Acme' };

  it('creates a tenant and returns the API key exactly once', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^aa_live_[0-9a-f]{48}$/);
    expect(res.body.tenant.brandName).toBe('Acme');

    const stored = await prisma.tenant.findUnique({ where: { id: res.body.tenant.id } });
    expect(stored?.apiKeyHash).toBe(sha256Hex(res.body.apiKey));
    // The key itself is never persisted anywhere.
    expect(JSON.stringify(stored)).not.toContain(res.body.apiKey);
  });

  it('refuses a wrong admin key', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set('authorization', 'Bearer wrong')
      .send(body);
    expect(res.status).toBe(401);
  });

  it('refuses provisioning when no admin key is configured', async () => {
    delete process.env.ADMIN_API_KEY;
    const res = await request(app)
      .post('/v1/tenants')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .send(body);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('admin_key_unset');
  });

  it('rejects a bad colour with a 400 that names the field', async () => {
    const res = await request(app)
      .post('/v1/tenants')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .send({ ...body, brandColor: 'red' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(JSON.stringify(res.body.error.details)).toContain('brandColor');
  });
});

describe('integrator authentication', () => {
  it('identifies the tenant behind an API key', async () => {
    const { tenant, apiKey } = await createTenant();
    const res = await request(app).get('/v1/tenants/me').set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.tenant.id).toBe(tenant.id);
  });

  it('refuses a missing, malformed or unknown key', async () => {
    expect((await request(app).get('/v1/tenants/me')).status).toBe(401);
    expect((await request(app).get('/v1/tenants/me').set('authorization', 'nonsense')).status).toBe(
      401,
    );
    expect(
      (await request(app).get('/v1/tenants/me').set('authorization', 'Bearer aa_live_nope')).status,
    ).toBe(401);
  });

  it('refuses a disabled tenant', async () => {
    const { tenant, apiKey } = await createTenant();
    await prisma.tenant.update({ where: { id: tenant.id }, data: { disabled: true } });
    const res = await request(app).get('/v1/tenants/me').set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('tenant_disabled');
  });
});

describe('PATCH /v1/tenants/me', () => {
  it('updates branding and caps', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app)
      .patch('/v1/tenants/me')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ brandName: 'New Brand', brandColor: '#ff0000', deviceCap: 1 });

    expect(res.status).toBe(200);
    expect(res.body.tenant).toMatchObject({
      brandName: 'New Brand',
      brandColor: '#ff0000',
      deviceCap: 1,
    });
  });

  it('refuses a device cap outside the allowed range', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app)
      .patch('/v1/tenants/me')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ deviceCap: 99 });
    expect(res.status).toBe(400);
  });
});

describe('subjects', () => {
  it('creates on first call and updates on the next, keeping one row', async () => {
    const { apiKey } = await createTenant();

    const first = await request(app)
      .put('/v1/tenants/me/subjects')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: 'cust_42', label: 'Acme Dental' });
    expect(first.status).toBe(200);

    const second = await request(app)
      .put('/v1/tenants/me/subjects')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: 'cust_42', label: 'Acme Dental Group', email: 'owner@acme.test' });

    expect(second.status).toBe(200);
    expect(second.body.subject.id).toBe(first.body.subject.id);
    expect(second.body.subject.label).toBe('Acme Dental Group');
    expect(await prisma.subject.count()).toBe(1);
  });

  it('keeps the same external id separate per tenant', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createSubject(a.tenant.id, 'shared');
    await createSubject(b.tenant.id, 'shared');
    expect(await prisma.subject.count()).toBe(2);
  });

  it('does not reveal another tenant subject', async () => {
    const a = await createTenant();
    const b = await createTenant();
    await createSubject(b.tenant.id, 'cust_9');

    const res = await request(app)
      .get('/v1/tenants/me/subjects/cust_9')
      .set('authorization', `Bearer ${a.apiKey}`);
    expect(res.status).toBe(404);
  });

  it('reports how many live devices a subject has', async () => {
    const { tenant, apiKey } = await createTenant();
    await createSubject(tenant.id, 'cust_7');
    const res = await request(app)
      .get('/v1/tenants/me/subjects/cust_7')
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.deviceCount).toBe(0);
  });
});

describe('health', () => {
  it('reports the database is reachable', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });
});

describe('unknown endpoints', () => {
  it('answers 404 in the standard error shape', async () => {
    const res = await request(app).get('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });
});
