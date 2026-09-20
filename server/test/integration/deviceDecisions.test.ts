import request from 'supertest';
import type { Device } from '@prisma/client';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { config } from '../../src/config';
import { decisionMessage, hashArgs, numericCode, randomId } from '../../src/lib/crypto';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject, createDevice } from '../helpers/factories';
import { deviceHeaders, type TestKeyPair } from '../helpers/keys';

const app = createApp();

const ARGS = { to: 'someone@example.test', subject: 'Invoice' };
const ARGS_HASH = hashArgs(ARGS);

/** A tenant with one subject and one paired phone — the normal starting point. */
async function pairedPhone(opts: { webhookUrl?: string } = {}) {
  const { tenant } = await createTenant(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {});
  const subject = await createSubject(tenant.id, 'cust_1');
  const phone = await createDevice(subject.id);
  return { tenant, subject, ...phone };
}

async function seedRequest(
  subjectId: string,
  overrides: Partial<{ status: string; expiresAt: Date; argsHash: string; resourceKey: string }> = {},
) {
  return prisma.approvalRequest.create({
    data: {
      id: randomId('req'),
      subjectId,
      actorLabel: 'Claude Code (laptop)',
      resourceKey: overrides.resourceKey ?? 'gmail/GMAIL_SEND_EMAIL',
      title: 'Send an email to someone@example.test',
      fieldsJson: JSON.stringify([
        { label: 'To', value: 'someone@example.test' },
        { label: 'Body', value: 'Please pay this.', sensitive: true },
      ]),
      argsHash: overrides.argsHash ?? ARGS_HASH,
      code: numericCode(),
      status: overrides.status ?? 'pending',
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 600_000),
    },
  });
}

interface DecisionOptions {
  requestId: string;
  keys: TestKeyPair;
  decision?: 'approved' | 'denied';
  scope?: 'once' | 'window';
  /** What the phone signs over. Defaults to the stored hash. */
  signedArgsHash?: string;
  signedAt?: number;
}

function decisionBody(opts: DecisionOptions) {
  const decision = opts.decision ?? 'approved';
  const scope = opts.scope ?? 'once';
  const signedAt = String(opts.signedAt ?? Math.floor(Date.now() / 1000));
  const signature = opts.keys.sign(
    decisionMessage({
      requestId: opts.requestId,
      decision,
      scope,
      argsHash: opts.signedArgsHash ?? ARGS_HASH,
      signedAt,
    }),
  );
  return { decision, scope, signedAt, signature };
}

/** Posts a decision the way the app does: device-signed envelope, signed body. */
function postDecision(
  device: Device,
  deviceKeys: TestKeyPair,
  requestId: string,
  body: Record<string, unknown>,
) {
  const path = `/v1/device/requests/${requestId}/decision`;
  return request(app)
    .post(path)
    .set(deviceHeaders(device.id, deviceKeys, 'POST', path, body))
    .send(body);
}

beforeEach(async () => {
  await resetDb();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /v1/device/requests', () => {
  it('lists this account open requests, newest first, without the arguments', async () => {
    const { tenant, subject, device, deviceKeys } = await pairedPhone();
    const older = await seedRequest(subject.id, { resourceKey: 'gmail/A' });
    const newer = await seedRequest(subject.id, { resourceKey: 'gmail/B' });
    await prisma.approvalRequest.update({
      where: { id: older.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });
    // Neither of these should show: one is answered, one has run out of time.
    await seedRequest(subject.id, { status: 'approved', resourceKey: 'gmail/C' });
    await seedRequest(subject.id, {
      expiresAt: new Date(Date.now() - 1000),
      resourceKey: 'gmail/D',
    });

    const res = await request(app)
      .get('/v1/device/requests')
      .set(deviceHeaders(device.id, deviceKeys, 'GET', '/v1/device/requests'));

    expect(res.status).toBe(200);
    expect(res.body.requests.map((r: { id: string }) => r.id)).toEqual([newer.id, older.id]);
    expect(res.body.requests[0].brandName).toBe(tenant.brandName);
    expect(res.body.requests[0].fields).toBeUndefined();
  });

  it('never shows another account requests', async () => {
    const mine = await pairedPhone();
    const theirs = await pairedPhone();
    await seedRequest(theirs.subject.id);

    const res = await request(app)
      .get('/v1/device/requests')
      .set(deviceHeaders(mine.device.id, mine.deviceKeys, 'GET', '/v1/device/requests'));
    expect(res.body.requests).toEqual([]);
  });

  it('refuses an unsigned call', async () => {
    await pairedPhone();
    const res = await request(app).get('/v1/device/requests');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/device/requests/:id', () => {
  it('returns the labelled fields for the approval screen', async () => {
    const { subject, device, deviceKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);
    const path = `/v1/device/requests/${approval.id}`;

    const res = await request(app)
      .get(path)
      .set(deviceHeaders(device.id, deviceKeys, 'GET', path));

    expect(res.status).toBe(200);
    expect(res.body.request.fields).toEqual([
      { label: 'To', value: 'someone@example.test', sensitive: false },
      { label: 'Body', value: 'Please pay this.', sensitive: true },
    ]);
    expect(res.body.request.argsHash).toBe(ARGS_HASH);
  });

  it('answers 404 for a request belonging to another subject', async () => {
    const mine = await pairedPhone();
    const theirs = await pairedPhone();
    const approval = await seedRequest(theirs.subject.id);
    const path = `/v1/device/requests/${approval.id}`;

    const res = await request(app)
      .get(path)
      .set(deviceHeaders(mine.device.id, mine.deviceKeys, 'GET', path));
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/device/requests/:id/decision', () => {
  it('approves, records who decided and leaves an audit trail', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys }),
    );

    expect(res.status).toBe(200);
    expect(res.body.request).toMatchObject({ id: approval.id, status: 'approved' });
    expect(res.body.request.decidedAt).toBeTruthy();

    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('approved');
    expect(stored?.decisionScope).toBe('once');

    const decision = await prisma.decision.findFirst({ where: { requestId: approval.id } });
    expect(decision?.deviceId).toBe(device.id);

    const audit = await prisma.auditEvent.findMany({ where: { type: 'request.decided' } });
    expect(audit).toHaveLength(1);
  });

  it('denies', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys, decision: 'denied' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('denied');
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('denied');
  });

  it('refuses a decision signed over different arguments', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    // A genuine signature — but for another call's arguments. Moving it here
    // must not work, or an approval could be lifted onto a different action.
    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: approvalKeys,
        signedArgsHash: hashArgs({ to: 'attacker@example.test' }),
      }),
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('pending');
  });

  it('refuses a decision signed by the wrong key', async () => {
    const { subject, device, deviceKeys } = await pairedPhone();
    const stranger = await createDevice((await pairedPhone()).subject.id);
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: stranger.approvalKeys }),
    );
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
  });

  it('refuses a decision signed too long ago', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: approvalKeys,
        signedAt: Math.floor(Date.now() / 1000) - (config.signatureSkewSec + 60),
      }),
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('stale_signature');
  });

  it('answers 404 when the request belongs to another subject', async () => {
    const mine = await pairedPhone();
    const theirs = await pairedPhone();
    const approval = await seedRequest(theirs.subject.id);

    const res = await postDecision(
      mine.device,
      mine.deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: mine.approvalKeys }),
    );

    expect(res.status).toBe(404);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('pending');
  });

  it('refuses a second decision on the same request', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const first = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys }),
    );
    const second = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys, decision: 'denied' }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('already_decided');
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('approved');
  });

  it('lets exactly one of two phones answering at once win', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const second = await createDevice(subject.id);
    const approval = await seedRequest(subject.id);

    const results = await Promise.all([
      postDecision(
        device,
        deviceKeys,
        approval.id,
        decisionBody({ requestId: approval.id, keys: approvalKeys }),
      ),
      postDecision(
        second.device,
        second.deviceKeys,
        approval.id,
        decisionBody({ requestId: approval.id, keys: second.approvalKeys, decision: 'denied' }),
      ),
    ]);

    const statuses = results.map(r => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await prisma.decision.count({ where: { requestId: approval.id } })).toBe(1);

    const winner = results.find(r => r.status === 200)!;
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe(winner.body.request.status);
  });

  it('grants a window when asked, and nothing when the scope is once', async () => {
    const windowed = await pairedPhone();
    const windowRequest = await seedRequest(windowed.subject.id);
    const granted = await postDecision(
      windowed.device,
      windowed.deviceKeys,
      windowRequest.id,
      decisionBody({
        requestId: windowRequest.id,
        keys: windowed.approvalKeys,
        scope: 'window',
      }),
    );
    expect(granted.status).toBe(200);

    const grants = await prisma.grant.findMany({ where: { subjectId: windowed.subject.id } });
    expect(grants).toHaveLength(1);
    expect(grants[0].resourceKey).toBe('gmail/GMAIL_SEND_EMAIL');
    const windowSec = (grants[0].expiresAt.getTime() - Date.now()) / 1000;
    expect(windowSec).toBeGreaterThan(config.grantWindowSec - 30);
    expect(windowSec).toBeLessThanOrEqual(config.grantWindowSec);

    const once = await pairedPhone();
    const onceRequest = await seedRequest(once.subject.id);
    await postDecision(
      once.device,
      once.deviceKeys,
      onceRequest.id,
      decisionBody({ requestId: onceRequest.id, keys: once.approvalKeys, scope: 'once' }),
    );
    expect(await prisma.grant.count({ where: { subjectId: once.subject.id } })).toBe(0);
  });

  it('does not create a grant when the answer is a denial', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);
    await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: approvalKeys,
        decision: 'denied',
        scope: 'window',
      }),
    );
    expect(await prisma.grant.count()).toBe(0);
  });

  it('refuses a request that has run out of time, and closes it', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id, { expiresAt: new Date(Date.now() - 1000) });

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys }),
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('expired');
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('expired');
    expect(await prisma.decision.count()).toBe(0);
  });

  it('queues a webhook for a tenant that has a url, and none for one that has not', async () => {
    const hooked = await pairedPhone({ webhookUrl: 'https://hub.example.test/approvals' });
    const hookedRequest = await seedRequest(hooked.subject.id);
    await postDecision(
      hooked.device,
      hooked.deviceKeys,
      hookedRequest.id,
      decisionBody({ requestId: hookedRequest.id, keys: hooked.approvalKeys }),
    );
    expect(
      await prisma.webhookDelivery.count({ where: { requestId: hookedRequest.id } }),
    ).toBe(1);

    const quiet = await pairedPhone();
    const quietRequest = await seedRequest(quiet.subject.id);
    await postDecision(
      quiet.device,
      quiet.deviceKeys,
      quietRequest.id,
      decisionBody({ requestId: quietRequest.id, keys: quiet.approvalKeys }),
    );
    expect(await prisma.webhookDelivery.count({ where: { requestId: quietRequest.id } })).toBe(0);
  });

  it('rejects a body that is missing the signature', async () => {
    const { subject, device, deviceKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);
    const body = { decision: 'approved', scope: 'once', signedAt: '1700000000' };

    const res = await postDecision(device, deviceKeys, approval.id, body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
  });
});
