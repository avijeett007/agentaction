import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { randomId } from '../../src/lib/crypto';
import { resetDb } from '../helpers/db';
import { createSubject, createTenant } from '../helpers/factories';

/**
 * The rules over HTTP: what the portal writes on behalf of an agency and its
 * customers, and what the MCP gateway asks before every tool call.
 */

const app = createApp();

const SEND = 'gmail/GMAIL_SEND_EMAIL';
const DRAFT = 'gmail/GMAIL_CREATE_DRAFT';
const ANY_GMAIL = 'gmail/*';

let apiKey: string;
let tenantId: string;
let subjectId: string;
const EXTERNAL_ID = 'cust_policy';

beforeEach(async () => {
  await resetDb();
  const created = await createTenant();
  apiKey = created.apiKey;
  tenantId = created.tenant.id;
  subjectId = (await createSubject(created.tenant.id, EXTERNAL_ID)).id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

const auth = () => `Bearer ${apiKey}`;

function agencyRule(resourceKey: string, enabled: boolean, locked = false, tenant = tenantId) {
  return prisma.policy.create({
    data: { id: randomId('pol'), tenantId: tenant, subjectId: null, resourceKey, enabled, locked },
  });
}

const evaluate = (body: Record<string, unknown>) =>
  request(app).post('/v1/policies/evaluate').set('authorization', auth()).send(body);

describe('authentication', () => {
  it('refuses every route without an integrator key', async () => {
    expect((await request(app).get('/v1/policies?externalId=x')).status).toBe(401);
    expect((await request(app).put('/v1/policies/tenant').send({})).status).toBe(401);
    expect((await request(app).post('/v1/policies/evaluate').send({})).status).toBe(401);
  });
});

describe('GET /v1/policies', () => {
  it('returns the rules as the customer experiences them', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    await agencyRule('slack/SLACK_POST', true);

    await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: 'slack/SLACK_POST', enabled: false });

    const res = await request(app)
      .get('/v1/policies')
      .query({ externalId: EXTERNAL_ID })
      .set('authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.policies).toEqual([
      {
        resourceKey: ANY_GMAIL,
        gated: true,
        reason: 'locked',
        locked: true,
        customerSetting: null,
        tenantDefault: true,
      },
      {
        resourceKey: 'slack/SLACK_POST',
        gated: false,
        reason: 'customer',
        locked: false,
        customerSetting: false,
        tenantDefault: true,
      },
    ]);
  });

  it('answers 404 for a subject this agency does not have', async () => {
    const res = await request(app)
      .get('/v1/policies')
      .query({ externalId: 'never_heard_of' })
      .set('authorization', auth());
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('will not read another agency customer', async () => {
    const other = await createTenant();
    await createSubject(other.tenant.id, 'their_customer');

    const res = await request(app)
      .get('/v1/policies')
      .query({ externalId: 'their_customer' })
      .set('authorization', auth());
    expect(res.status).toBe(404);
  });

  it('needs an externalId', async () => {
    const res = await request(app).get('/v1/policies').set('authorization', auth());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('PUT /v1/policies/subject', () => {
  it('turns a rule on, then off again, keeping one row', async () => {
    const on = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: true });

    expect(on.status).toBe(200);
    expect(on.body.policy).toEqual({
      resourceKey: SEND,
      enabled: true,
      locked: false,
      scope: 'subject',
    });
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: true,
      reason: 'customer',
      matchedKey: SEND,
    });

    const off = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: false });

    expect(off.status).toBe(200);
    expect(off.body.policy.enabled).toBe(false);
    expect(await prisma.policy.count({ where: { subjectId } })).toBe(1);
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body.gated).toBe(false);
  });

  it('records the change in the audit trail', async () => {
    await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: true });

    const event = await prisma.auditEvent.findFirst({ where: { type: 'policy.subject.updated' } });
    expect(event?.subjectId).toBe(subjectId);
    expect(JSON.parse(event!.dataJson)).toEqual({ resourceKey: SEND, enabled: true });
  });

  it('refuses to switch off a rule the agency has locked on, naming the agency', async () => {
    await agencyRule(ANY_GMAIL, true, true);

    const res = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: false });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('policy_locked');
    expect(res.body.error.message).toContain('Test Agency');
    expect(res.body.error.message).toContain(ANY_GMAIL);
    // Nothing was written, and the lock still decides.
    expect(await prisma.policy.count({ where: { subjectId } })).toBe(0);
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: ANY_GMAIL,
    });
  });

  it('still allows switching a locked rule on, which changes nothing', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    const res = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: true });
    expect(res.status).toBe(200);
  });

  it('accepts an oddly-cased app half and folds it, rather than rejecting', async () => {
    // Forgiving on the way in, canonical in the row: the whole point is that two
    // callers spelling the key differently must not end up with two rules.
    const res = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: 'GMAIL/send', enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.policy.resourceKey).toBe('gmail/SEND');
  });

  it('rejects a resourceKey that is not "<app>/<tool>"', async () => {
    for (const resourceKey of ['gmail', 'gmail/', '/send', `gmail/${'x'.repeat(220)}`]) {
      const res = await request(app)
        .put('/v1/policies/subject')
        .set('authorization', auth())
        .send({ externalId: EXTERNAL_ID, resourceKey, enabled: true });
      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body.error.details)).toContain('resourceKey');
    }
  });

  it('will not touch another agency customer', async () => {
    const other = await createTenant();
    await createSubject(other.tenant.id, 'their_customer');

    const res = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: 'their_customer', resourceKey: SEND, enabled: true });
    expect(res.status).toBe(404);
    expect(await prisma.policy.count()).toBe(0);
  });
});

describe('PUT /v1/policies/tenant', () => {
  it('sets a default, then locks it, keeping one agency row', async () => {
    const first = await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', auth())
      .send({ resourceKey: ANY_GMAIL, enabled: true });

    expect(first.status).toBe(200);
    expect(first.body.policy).toEqual({
      resourceKey: ANY_GMAIL,
      enabled: true,
      locked: false,
      scope: 'tenant',
    });

    // The customer may opt out while the rule is only a default.
    const optOut = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: ANY_GMAIL, enabled: false });
    expect(optOut.status).toBe(200);

    const locked = await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', auth())
      .send({ resourceKey: ANY_GMAIL, enabled: true, locked: true });

    expect(locked.status).toBe(200);
    expect(locked.body.policy.locked).toBe(true);
    expect(await prisma.policy.count({ where: { subjectId: null } })).toBe(1);

    // And now the lock overrides the opt-out the customer already made.
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: DRAFT })).body).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: ANY_GMAIL,
    });

    const list = await request(app)
      .get('/v1/policies')
      .query({ externalId: EXTERNAL_ID })
      .set('authorization', auth());
    expect(list.body.policies).toContainEqual({
      resourceKey: ANY_GMAIL,
      gated: true,
      reason: 'locked',
      locked: true,
      customerSetting: false,
      tenantDefault: true,
    });

    const event = await prisma.auditEvent.findFirst({ where: { type: 'policy.tenant.updated' } });
    expect(event).not.toBeNull();
  });

  it('keeps each agency rules to itself', async () => {
    const other = await createTenant();
    await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', `Bearer ${other.apiKey}`)
      .send({ resourceKey: ANY_GMAIL, enabled: true, locked: true });

    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: false,
      reason: 'off',
    });
  });
});

describe('DELETE /v1/policies/subject', () => {
  it('drops the customer row so the agency default applies again', async () => {
    await agencyRule(SEND, true);
    await request(app)
      .put('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND, enabled: false });
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body.reason).toBe(
      'customer',
    );

    const res = await request(app)
      .delete('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true });
    expect(await prisma.policy.count({ where: { subjectId } })).toBe(0);
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: true,
      reason: 'default',
      matchedKey: SEND,
    });
  });

  it('is harmless when there is nothing to remove', async () => {
    const res = await request(app)
      .delete('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: false });
  });

  it('refuses while the agency holds the rule on', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    const res = await request(app)
      .delete('/v1/policies/subject')
      .set('authorization', auth())
      .send({ externalId: EXTERNAL_ID, resourceKey: SEND });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('policy_locked');
  });
});

describe('POST /v1/policies/evaluate', () => {
  it('gates on the agency default and says where the answer came from', async () => {
    await agencyRule(ANY_GMAIL, true);
    const res = await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gated: true, reason: 'default', matchedKey: ANY_GMAIL });
  });

  it('does not gate a tool no one has a rule for', async () => {
    await agencyRule(ANY_GMAIL, true);
    const res = await evaluate({ externalId: EXTERNAL_ID, resourceKey: 'slack/SLACK_POST' });
    expect(res.body).toEqual({ gated: false, reason: 'off' });
  });

  it('lets a live grant through, and gates again once it has expired', async () => {
    await agencyRule(SEND, true, true);
    const grant = await prisma.grant.create({
      data: {
        id: randomId('grn'),
        subjectId,
        resourceKey: SEND,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: false,
      reason: 'grant',
      matchedKey: SEND,
    });

    await prisma.grant.update({
      where: { id: grant.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await evaluate({ externalId: EXTERNAL_ID, resourceKey: SEND })).body).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: SEND,
    });
  });

  it('answers 200 and ungated for a customer we have never heard of, creating nothing', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    const res = await evaluate({ externalId: 'never_paired', resourceKey: SEND });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gated: false, reason: 'off' });
    expect(await prisma.subject.count()).toBe(1);
    expect(await prisma.policy.count({ where: { subjectId: { not: null } } })).toBe(0);
  });

  it('will not evaluate another agency customer', async () => {
    const other = await createTenant();
    const theirSubject = await createSubject(other.tenant.id, 'their_customer');
    await prisma.policy.create({
      data: {
        id: randomId('pol'),
        tenantId: other.tenant.id,
        subjectId: theirSubject.id,
        resourceKey: SEND,
        enabled: true,
      },
    });

    const res = await evaluate({ externalId: 'their_customer', resourceKey: SEND });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ gated: false, reason: 'off' });
  });

  it('rejects a malformed body', async () => {
    const res = await evaluate({ externalId: EXTERNAL_ID, resourceKey: 'not a key' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});

describe('GET /v1/policies/tenant', () => {
  it('lists the agency rows, and only its own', async () => {
    const a = await createTenant();
    const b = await createTenant();

    await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', `Bearer ${a.apiKey}`)
      .send({ resourceKey: 'gmail/GMAIL_SEND_EMAIL', enabled: true, locked: true });
    await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', `Bearer ${a.apiKey}`)
      .send({ resourceKey: 'ghl/*', enabled: true, locked: false });
    await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', `Bearer ${b.apiKey}`)
      .send({ resourceKey: 'stripe/REFUND', enabled: true, locked: true });

    const res = await request(app)
      .get('/v1/policies/tenant')
      .set('authorization', `Bearer ${a.apiKey}`);

    expect(res.status).toBe(200);
    expect(res.body.policies).toEqual([
      { resourceKey: 'ghl/*', enabled: true, locked: false, scope: 'tenant' },
      { resourceKey: 'gmail/GMAIL_SEND_EMAIL', enabled: true, locked: true, scope: 'tenant' },
    ]);
  });

  it('never returns a customer row', async () => {
    const { tenant, apiKey } = await createTenant();
    const subject = await createSubject(tenant.id, 'cust_1');
    await request(app)
      .put('/v1/policies/subject')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: subject.externalId, resourceKey: 'gmail/ONLY_CUSTOMER', enabled: true });

    const res = await request(app)
      .get('/v1/policies/tenant')
      .set('authorization', `Bearer ${apiKey}`);
    expect(res.body.policies).toEqual([]);
  });

  it('needs an API key', async () => {
    expect((await request(app).get('/v1/policies/tenant')).status).toBe(401);
  });
});

describe('resourceKey canonicalisation', () => {
  // The portal writes rules and the gateway reads them. If they spell the key
  // differently the rule saves, renders as on, and gates nothing — so the
  // server folds both sides rather than trusting either caller.
  it('stores a lowercase tool name in canonical form', async () => {
    const { tenant, apiKey } = await createTenant();
    const subject = await createSubject(tenant.id, 'cust_1');

    const write = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: subject.externalId, resourceKey: 'srv-uuid/search_docs', enabled: true });
    expect(write.status).toBe(200);

    const stored = await prisma.policy.findFirst({ where: { subjectId: subject.id } });
    expect(stored?.resourceKey).toBe('srv-uuid/SEARCH_DOCS');
  });

  it('evaluates the same rule however the caller spells it', async () => {
    const { tenant, apiKey } = await createTenant();
    const subject = await createSubject(tenant.id, 'cust_2');

    await request(app)
      .put('/v1/policies/subject')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: subject.externalId, resourceKey: 'srv-uuid/search_docs', enabled: true });

    for (const spelling of ['srv-uuid/search_docs', 'srv-uuid/SEARCH_DOCS', 'SRV-UUID/Search_Docs']) {
      const res = await request(app)
        .post('/v1/policies/evaluate')
        .set('authorization', `Bearer ${apiKey}`)
        .send({ externalId: subject.externalId, resourceKey: spelling });
      expect(res.body).toMatchObject({ gated: true });
    }
  });

  it('keeps a wildcard a wildcard', async () => {
    const { apiKey } = await createTenant();
    const res = await request(app)
      .put('/v1/policies/tenant')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ resourceKey: 'GMAIL/*', enabled: true, locked: false });
    expect(res.status).toBe(200);
    expect(res.body.policy.resourceKey).toBe('gmail/*');
  });
});
