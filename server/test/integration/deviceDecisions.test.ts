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
async function pairedPhone(opts: { webhookUrl?: string; maxGrantWindowSec?: number } = {}) {
  const { tenant } = await createTenant({
    ...(opts.webhookUrl ? { webhookUrl: opts.webhookUrl } : {}),
    ...(opts.maxGrantWindowSec === undefined
      ? {}
      : { maxGrantWindowSec: opts.maxGrantWindowSec }),
  });
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
  /** The window sent on the wire. Defaults to 0 for once, 900 for a window. */
  windowSec?: number;
  /** The window actually signed, when it differs from the one sent. */
  signedWindowSec?: number;
  /** What the phone signs over. Defaults to the stored hash. */
  signedArgsHash?: string;
  signedAt?: number;
}

function decisionBody(opts: DecisionOptions) {
  const decision = opts.decision ?? 'approved';
  const scope = opts.scope ?? 'once';
  const windowSec = opts.windowSec ?? (scope === 'window' ? 900 : 0);
  const signedAt = String(opts.signedAt ?? Math.floor(Date.now() / 1000));
  const signature = opts.keys.sign(
    decisionMessage({
      requestId: opts.requestId,
      decision,
      scope,
      windowSec: opts.signedWindowSec ?? windowSec,
      argsHash: opts.signedArgsHash ?? ARGS_HASH,
      signedAt,
    }),
  );
  return { decision, scope, windowSec, signedAt, signature };
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

  it('carries the agency ceiling, so the phone cannot offer a window it would refuse', async () => {
    const standard = await pairedPhone();
    const standardRequest = await seedRequest(standard.subject.id);
    const standardPath = `/v1/device/requests/${standardRequest.id}`;
    const standardRes = await request(app)
      .get(standardPath)
      .set(deviceHeaders(standard.device.id, standard.deviceKeys, 'GET', standardPath));
    expect(standardRes.body.request.maxWindowSec).toBe(3600);

    const bank = await pairedPhone({ maxGrantWindowSec: 300 });
    const bankRequest = await seedRequest(bank.subject.id);
    const bankPath = `/v1/device/requests/${bankRequest.id}`;
    const bankRes = await request(app)
      .get(bankPath)
      .set(deviceHeaders(bank.device.id, bank.deviceKeys, 'GET', bankPath));
    expect(bankRes.body.request.maxWindowSec).toBe(300);
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

  it('creates no grant at all when the scope is once', async () => {
    const once = await pairedPhone();
    const onceRequest = await seedRequest(once.subject.id);
    const res = await postDecision(
      once.device,
      once.deviceKeys,
      onceRequest.id,
      decisionBody({ requestId: onceRequest.id, keys: once.approvalKeys, scope: 'once' }),
    );

    expect(res.status).toBe(200);
    expect(res.body.grant).toBeNull();
    expect(await prisma.grant.count({ where: { subjectId: once.subject.id } })).toBe(0);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: onceRequest.id } });
    expect(stored?.decisionScope).toBe('once');
    expect(stored?.decisionWindowSec).toBeNull();
  });

  it('treats an absent window as zero, and verifies the signature that way', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);
    const signed = decisionBody({ requestId: approval.id, keys: approvalKeys, scope: 'once' });

    // A body with no `windowSec` at all, signed over an explicit 0. The two
    // have to mean the same thing, or the shortest possible approval — the
    // common one — would fail on the wire.
    const res = await postDecision(device, deviceKeys, approval.id, {
      decision: signed.decision,
      scope: signed.scope,
      signedAt: signed.signedAt,
      signature: signed.signature,
    });

    expect(res.status).toBe(200);
    expect(await prisma.grant.count()).toBe(0);
  });

  it('grants exactly the window the phone signed for, whichever one it is', async () => {
    // Every window the app offers, end to end. 8h is left out because the
    // default tenant ceiling is an hour — that case has its own test below.
    for (const windowSec of [300, 900, 3600]) {
      const phone = await pairedPhone();
      const approval = await seedRequest(phone.subject.id);

      const res = await postDecision(
        phone.device,
        phone.deviceKeys,
        approval.id,
        decisionBody({
          requestId: approval.id,
          keys: phone.approvalKeys,
          scope: 'window',
          windowSec,
        }),
      );

      expect(res.status).toBe(200);
      expect(res.body.grant).toMatchObject({
        windowSec,
        requestedWindowSec: windowSec,
        clamped: false,
      });

      const grants = await prisma.grant.findMany({ where: { subjectId: phone.subject.id } });
      expect(grants).toHaveLength(1);
      expect(grants[0].resourceKey).toBe('gmail/GMAIL_SEND_EMAIL');
      const actualSec = (grants[0].expiresAt.getTime() - Date.now()) / 1000;
      expect(actualSec).toBeGreaterThan(windowSec - 30);
      expect(actualSec).toBeLessThanOrEqual(windowSec);

      // And the row an integrator reads says how long, not merely "a window".
      const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
      expect(stored).toMatchObject({ decisionScope: 'window', decisionWindowSec: windowSec });
      const decision = await prisma.decision.findFirst({ where: { requestId: approval.id } });
      expect(decision).toMatchObject({ scope: 'window', windowSec });
    }
  });

  it('allows eight hours only where the tenant has raised its ceiling', async () => {
    const raised = await pairedPhone({ maxGrantWindowSec: 28800 });
    const longRequest = await seedRequest(raised.subject.id);
    const allowed = await postDecision(
      raised.device,
      raised.deviceKeys,
      longRequest.id,
      decisionBody({
        requestId: longRequest.id,
        keys: raised.approvalKeys,
        scope: 'window',
        windowSec: 28800,
      }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.grant).toMatchObject({ windowSec: 28800, clamped: false });

    // The same request against a tenant that has not raised it is shortened,
    // and the answer says so rather than quietly handing back less.
    const standard = await pairedPhone();
    const cappedRequest = await seedRequest(standard.subject.id);
    const capped = await postDecision(
      standard.device,
      standard.deviceKeys,
      cappedRequest.id,
      decisionBody({
        requestId: cappedRequest.id,
        keys: standard.approvalKeys,
        scope: 'window',
        windowSec: 28800,
      }),
    );
    expect(capped.status).toBe(200);
    expect(capped.body.grant).toMatchObject({
      windowSec: 3600,
      requestedWindowSec: 28800,
      maxWindowSec: 3600,
      clamped: true,
    });
    const grants = await prisma.grant.findMany({ where: { subjectId: standard.subject.id } });
    const actualSec = (grants[0].expiresAt.getTime() - Date.now()) / 1000;
    expect(actualSec).toBeLessThanOrEqual(3600);
  });

  it('clamps every customer of a five-minute agency to five minutes', async () => {
    // The bank case: the agency caps the window, the phone does not get a vote.
    const bank = await pairedPhone({ maxGrantWindowSec: 300 });
    const approval = await seedRequest(bank.subject.id);

    const res = await postDecision(
      bank.device,
      bank.deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: bank.approvalKeys,
        scope: 'window',
        windowSec: 3600,
      }),
    );

    expect(res.status).toBe(200);
    expect(res.body.grant).toMatchObject({
      windowSec: 300,
      requestedWindowSec: 3600,
      maxWindowSec: 300,
      clamped: true,
    });
    const grants = await prisma.grant.findMany({ where: { subjectId: bank.subject.id } });
    const actualSec = (grants[0].expiresAt.getTime() - Date.now()) / 1000;
    expect(actualSec).toBeGreaterThan(270);
    expect(actualSec).toBeLessThanOrEqual(300);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.decisionWindowSec).toBe(300);
  });

  it('grants nothing at all for a tenant whose ceiling is zero', async () => {
    const strict = await pairedPhone({ maxGrantWindowSec: 0 });
    const approval = await seedRequest(strict.subject.id);

    const res = await postDecision(
      strict.device,
      strict.deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: strict.approvalKeys,
        scope: 'window',
        windowSec: 300,
      }),
    );

    // The approval stands — it just covers this one call.
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('approved');
    expect(res.body.grant).toMatchObject({ windowSec: 0, clamped: true });
    expect(await prisma.grant.count({ where: { subjectId: strict.subject.id } })).toBe(0);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.decisionScope).toBe('once');
  });

  it('refuses a window that is not one of the offered durations', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    // Ten minutes is perfectly reasonable and is not on the list. The set is
    // closed so that every hop agrees on it; an odd value is a client that has
    // drifted, and guessing what it meant is how five minutes becomes eight
    // hours.
    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys, scope: 'window', windowSec: 600 }),
    );

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_request');
    expect(await prisma.grant.count()).toBe(0);
    expect(await prisma.decision.count()).toBe(0);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('pending');
  });

  it('refuses a once decision that smuggles a window alongside it', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({ requestId: approval.id, keys: approvalKeys, scope: 'once', windowSec: 900 }),
    );

    expect(res.status).toBe(400);
    expect(await prisma.grant.count()).toBe(0);
  });

  it('refuses a decision signed over a different window', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone({
      maxGrantWindowSec: 28800,
    });
    const approval = await seedRequest(subject.id);

    // The attack this whole change exists to stop: a genuine signature for a
    // five-minute grant, with eight hours put on the wire beside it. If the
    // duration were not inside the signed message, this would succeed.
    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      decisionBody({
        requestId: approval.id,
        keys: approvalKeys,
        scope: 'window',
        windowSec: 28800,
        signedWindowSec: 300,
      }),
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
    expect(await prisma.grant.count()).toBe(0);
    const stored = await prisma.approvalRequest.findUnique({ where: { id: approval.id } });
    expect(stored?.status).toBe('pending');
  });

  it('refuses a decision signed as once and sent as a window', async () => {
    const { subject, device, deviceKeys, approvalKeys } = await pairedPhone();
    const approval = await seedRequest(subject.id);

    const res = await postDecision(
      device,
      deviceKeys,
      approval.id,
      {
        ...decisionBody({ requestId: approval.id, keys: approvalKeys, scope: 'once' }),
        scope: 'window',
        windowSec: 900,
      },
    );

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('bad_signature');
    expect(await prisma.grant.count()).toBe(0);
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
