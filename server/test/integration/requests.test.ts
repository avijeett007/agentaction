import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { config } from '../../src/config';
import { hashArgs } from '../../src/lib/crypto';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject } from '../helpers/factories';

const app = createApp();

const ARGS = { to: 'someone@example.test', subject: 'Invoice' };

function body(overrides: Record<string, unknown> = {}) {
  return {
    externalId: 'cust_1',
    actorLabel: 'Claude Code (laptop)',
    resourceKey: 'gmail/GMAIL_SEND_EMAIL',
    title: 'Send an email to someone@example.test',
    fields: [
      { label: 'To', value: 'someone@example.test' },
      { label: 'Body', value: 'Please pay this.', sensitive: true },
    ],
    argsHash: hashArgs(ARGS),
    ...overrides,
  };
}

async function seedTenantAndSubject(requestTtlSec?: number) {
  const { tenant, apiKey } = await createTenant(
    requestTtlSec === undefined ? {} : { requestTtlSec },
  );
  const subject = await createSubject(tenant.id, 'cust_1');
  return { tenant, apiKey, subject };
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /v1/requests', () => {
  it('parks a call and hands the agent a code to read out', async () => {
    const { apiKey, subject } = await seedTenantAndSubject();

    const res = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    expect(res.status).toBe(201);
    expect(res.body.request.code).toMatch(/^\d{4}$/);
    expect(res.body.request.status).toBe('pending');
    expect(res.body.deduplicated).toBeUndefined();

    const stored = await prisma.approvalRequest.findUnique({ where: { id: res.body.request.id } });
    expect(stored?.subjectId).toBe(subject.id);
    expect(stored?.argsHash).toBe(hashArgs(ARGS));
    // The display payload is kept verbatim for the phone to render.
    expect(JSON.parse(stored!.fieldsJson)).toHaveLength(2);
  });

  it('records the creation in the audit trail', async () => {
    const { apiKey } = await seedTenantAndSubject();
    await request(app).post('/v1/requests').set('authorization', `Bearer ${apiKey}`).send(body());

    const events = await prisma.auditEvent.findMany({ where: { type: 'request.created' } });
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].dataJson).resourceKey).toBe('gmail/GMAIL_SEND_EMAIL');
  });

  it('reuses the open request when an agent retries the identical call', async () => {
    const { apiKey } = await seedTenantAndSubject();

    const first = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    const second = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    expect(second.status).toBe(201);
    expect(second.body.deduplicated).toBe(true);
    expect(second.body.request.id).toBe(first.body.request.id);
    expect(second.body.request.code).toBe(first.body.request.code);
    // One request, so one notification on the phone.
    expect(await prisma.approvalRequest.count()).toBe(1);
  });

  it('creates a second request when the arguments differ', async () => {
    const { apiKey } = await seedTenantAndSubject();
    await request(app).post('/v1/requests').set('authorization', `Bearer ${apiKey}`).send(body());
    const other = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body({ argsHash: hashArgs({ ...ARGS, subject: 'Something else' }) }));

    expect(other.body.deduplicated).toBeUndefined();
    expect(await prisma.approvalRequest.count()).toBe(2);
  });

  it('does not reuse a request that has already been decided', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const first = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    await prisma.approvalRequest.update({
      where: { id: first.body.request.id },
      data: { status: 'approved', decidedAt: new Date() },
    });

    const second = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    expect(second.body.request.id).not.toBe(first.body.request.id);
    expect(await prisma.approvalRequest.count()).toBe(2);
  });

  it('clamps a silly ttl into the operator bounds', async () => {
    const { apiKey } = await seedTenantAndSubject();

    const tooShort = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body({ ttlSec: 5 }));
    const tooLong = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body({ ttlSec: 999999, argsHash: hashArgs({ n: 2 }) }));

    expect(ttlOf(tooShort)).toBeCloseTo(config.minRequestTtlSec, -1);
    expect(ttlOf(tooLong)).toBeCloseTo(config.maxRequestTtlSec, -1);
  });

  it('falls back to the tenant default ttl', async () => {
    const { apiKey } = await seedTenantAndSubject(900);
    const res = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    expect(ttlOf(res)).toBeCloseTo(900, -1);
  });

  it('refuses an unknown subject', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const res = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body({ externalId: 'nobody' }));
    expect(res.status).toBe(404);
  });

  it('refuses a subject belonging to another tenant', async () => {
    // The subject exists — but not for this API key, and the answer must not
    // say otherwise.
    const owner = await createTenant();
    await createSubject(owner.tenant.id, 'cust_1');
    const stranger = await createTenant();

    const res = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${stranger.apiKey}`)
      .send(body());
    expect(res.status).toBe(404);
    expect(await prisma.approvalRequest.count()).toBe(0);
  });

  it('rejects an arguments hash that is not a sha256 digest', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const res = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body({ argsHash: 'not-a-hash' }));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(JSON.stringify(res.body.error.details)).toContain('argsHash');
  });

  it('needs an API key', async () => {
    const res = await request(app).post('/v1/requests').send(body());
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/requests/:id', () => {
  it('reports the decision and which phone made it', async () => {
    const { apiKey, subject } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    const device = await prisma.device.create({
      data: {
        id: 'dev_reader',
        subjectId: subject.id,
        label: 'iPhone',
        platform: 'ios',
        devicePubKey: 'x',
        approvalPubKey: 'y',
      },
    });
    await prisma.approvalRequest.update({
      where: { id: created.body.request.id },
      data: { status: 'approved', decidedAt: new Date(), decisionScope: 'window' },
    });
    await prisma.decision.create({
      data: {
        id: 'dec_1',
        requestId: created.body.request.id,
        deviceId: device.id,
        decision: 'approved',
        scope: 'window',
        signature: 'sig',
        signedAt: new Date(),
      },
    });

    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}`)
      .set('authorization', `Bearer ${apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({
      status: 'approved',
      decisionScope: 'window',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      argsHash: hashArgs(ARGS),
      decidedByDeviceId: device.id,
    });
  });

  it('expires a stale request as it is read, without waiting for the sweeper', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    await prisma.approvalRequest.update({
      where: { id: created.body.request.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}`)
      .set('authorization', `Bearer ${apiKey}`);

    expect(res.body.request.status).toBe('expired');
    const stored = await prisma.approvalRequest.findUnique({
      where: { id: created.body.request.id },
    });
    expect(stored?.status).toBe('expired');
  });

  it('answers 404 for an unknown id and for another tenant request', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    const stranger = await createTenant();
    const mine = await request(app)
      .get('/v1/requests/req_nope')
      .set('authorization', `Bearer ${apiKey}`);
    const theirs = await request(app)
      .get(`/v1/requests/${created.body.request.id}`)
      .set('authorization', `Bearer ${stranger.apiKey}`);

    expect(mine.status).toBe(404);
    expect(theirs.status).toBe(404);
  });
});

describe('GET /v1/requests/:id/wait', () => {
  it('returns as soon as a decision lands', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    // A Prisma promise is lazy: it only runs once something awaits it, hence
    // the explicit .catch() rather than a bare `void`.
    const timer = setTimeout(() => {
      prisma.approvalRequest
        .update({
          where: { id: created.body.request.id },
          data: { status: 'approved', decidedAt: new Date(), decisionScope: 'once' },
        })
        .catch(() => undefined);
    }, 300);

    const startedAt = Date.now();
    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}/wait?timeout=10`)
      .set('authorization', `Bearer ${apiKey}`);
    const elapsed = Date.now() - startedAt;
    clearTimeout(timer);

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('approved');
    // Well under the 10s it was allowed to wait: it noticed, it did not time out.
    expect(elapsed).toBeLessThan(4000);
  });

  it('returns the pending state when the timeout runs out', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());

    const startedAt = Date.now();
    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}/wait?timeout=1`)
      .set('authorization', `Bearer ${apiKey}`);
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('pending');
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('returns immediately when the request has already been decided', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    await prisma.approvalRequest.update({
      where: { id: created.body.request.id },
      data: { status: 'denied', decidedAt: new Date() },
    });

    const startedAt = Date.now();
    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}/wait?timeout=5`)
      .set('authorization', `Bearer ${apiKey}`);

    expect(res.body.request.status).toBe('denied');
    expect(Date.now() - startedAt).toBeLessThan(1500);
  });

  it('gives up waiting on a request that expires mid-wait', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    await prisma.approvalRequest.update({
      where: { id: created.body.request.id },
      data: { expiresAt: new Date(Date.now() + 400) },
    });

    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}/wait?timeout=10`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.body.request.status).toBe('expired');
  });

  it('rejects a timeout that is not a number', async () => {
    const { apiKey } = await seedTenantAndSubject();
    const created = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send(body());
    const res = await request(app)
      .get(`/v1/requests/${created.body.request.id}/wait?timeout=soon`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(400);
  });
});

/** Seconds between creation and expiry, as the caller sees them. */
function ttlOf(res: { body: { request: { createdAt: string; expiresAt: string } } }): number {
  const created = new Date(res.body.request.createdAt).getTime();
  const expires = new Date(res.body.request.expiresAt).getTime();
  return (expires - created) / 1000;
}
