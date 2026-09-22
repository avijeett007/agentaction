import { prisma } from '../../src/prisma';
import { hashArgs, numericCode, randomId, verifyWebhookSignature } from '../../src/lib/crypto';
import {
  deliverPending,
  queueDecisionWebhook,
  startWebhookWorker,
} from '../../src/services/webhooks';
import { expireOverdue, startExpirySweeper } from '../../src/services/expiry';
import { resetDb } from '../helpers/db';
import { createTenant, createSubject } from '../helpers/factories';

const WEBHOOK_URL = 'https://hub.example.test/approvals';
const ARGS_HASH = hashArgs({ to: 'someone@example.test' });

const realFetch = global.fetch;
let fetchMock: jest.Mock;

/** A stand-in for what a receiver sends back. Only ok/status are ever read. */
function reply(status: number) {
  return { ok: status >= 200 && status < 300, status, text: async () => '' } as unknown as Response;
}

/** A decided request belonging to a tenant that wants to be told about it. */
async function decidedRequest(opts: { webhookUrl?: string | null } = {}) {
  const { tenant } = await createTenant(
    opts.webhookUrl === null ? {} : { webhookUrl: opts.webhookUrl ?? WEBHOOK_URL },
  );
  const subject = await createSubject(tenant.id, 'cust_1');
  const approval = await prisma.approvalRequest.create({
    data: {
      id: randomId('req'),
      subjectId: subject.id,
      actorLabel: 'Claude Code (laptop)',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      title: 'Send an email',
      fieldsJson: '[]',
      argsHash: ARGS_HASH,
      code: numericCode(),
      status: 'approved',
      decisionScope: 'once',
      decidedAt: new Date(),
      expiresAt: new Date(Date.now() + 600_000),
    },
  });
  return { tenant, subject, approval };
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    { headers: Record<string, string>; body: string; method: string },
  ];
  return { url, init };
}

beforeEach(async () => {
  await resetDb();
  fetchMock = jest.fn(async () => reply(200));
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterAll(async () => {
  global.fetch = realFetch;
  await prisma.$disconnect();
});

describe('queueDecisionWebhook', () => {
  it('records one delivery, due immediately, for a tenant with a url', async () => {
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);

    expect(id).toBeTruthy();
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: id! } });
    expect(delivery).toMatchObject({ requestId: approval.id, url: WEBHOOK_URL, status: 'pending' });
    expect(delivery!.attempts).toBe(0);
  });

  it('records nothing when the tenant has no webhook url', async () => {
    const { approval } = await decidedRequest({ webhookUrl: null });
    const id = await queueDecisionWebhook(approval.id);

    expect(id).toBeNull();
    expect(await prisma.webhookDelivery.count()).toBe(0);
  });

  it('shrugs off an unknown request instead of throwing', async () => {
    await expect(queueDecisionWebhook('req_nope')).resolves.toBeNull();
  });
});

describe('deliverPending', () => {
  it('posts a signed body the receiver can verify', async () => {
    const { tenant, approval } = await decidedRequest();
    await queueDecisionWebhook(approval.id);

    const run = await deliverPending(new Date());

    expect(run.delivered).toBe(1);
    const { url, init } = lastCall();
    expect(url).toBe(WEBHOOK_URL);
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    // The signature covers the exact bytes sent, so the receiver hashes the
    // raw body rather than a re-serialised object.
    expect(
      verifyWebhookSignature(
        tenant.webhookSecret,
        init.headers['x-agentaction-signature'],
        init.body,
      ),
    ).toBe(true);
    expect(JSON.parse(init.body)).toMatchObject({
      type: 'request.decided',
      requestId: approval.id,
      subjectExternalId: 'cust_1',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      status: 'approved',
      decisionScope: 'once',
      // An approval for this one call, said as a null rather than as a zero.
      decisionWindowSec: null,
      argsHash: ARGS_HASH,
    });
  });

  it('tells the integrator how long a granted window lasts', async () => {
    const { approval } = await decidedRequest();
    await prisma.approvalRequest.update({
      where: { id: approval.id },
      data: { decisionScope: 'window', decisionWindowSec: 900 },
    });
    await queueDecisionWebhook(approval.id);
    fetchMock.mockResolvedValue(new Response('', { status: 200 }));

    await deliverPending(new Date());

    // Without the number, "window" only says "and stop asking" — the caller
    // cannot tell whether that means five minutes or the rest of the day.
    expect(JSON.parse(lastCall().init.body)).toMatchObject({
      decisionScope: 'window',
      decisionWindowSec: 900,
    });
  });

  it('marks a 2xx delivered and stops trying', async () => {
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);

    await deliverPending(new Date());
    await deliverPending(new Date(Date.now() + 3_600_000));

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: id! } });
    expect(delivery).toMatchObject({ status: 'delivered', attempts: 1, nextAttempt: null });
    expect(delivery!.deliveredAt).toBeTruthy();
    // The second sweep found nothing due: a delivered row is never resent.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('backs off after a 500 instead of hammering the receiver', async () => {
    fetchMock.mockResolvedValue(reply(500));
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);

    const now = new Date();
    const run = await deliverPending(now);

    expect(run.retrying).toBe(1);
    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: id! } });
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1 });
    expect(delivery!.lastError).toContain('500');
    expect(delivery!.nextAttempt!.getTime()).toBeGreaterThan(now.getTime());

    // Not due yet, so a sweep a second later does nothing.
    await deliverPending(new Date(now.getTime() + 1000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a network failure the same as a refusal', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);

    await deliverPending(new Date());

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: id! } });
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1 });
    expect(delivery!.lastError).toContain('ECONNREFUSED');
  });

  it('gives up after six attempts', async () => {
    fetchMock.mockResolvedValue(reply(503));
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);

    // Each sweep is an hour later, so every backoff has always elapsed.
    for (let attempt = 0; attempt < 8; attempt++) {
      await deliverPending(new Date(Date.now() + attempt * 3_600_000));
    }

    const delivery = await prisma.webhookDelivery.findUnique({ where: { id: id! } });
    expect(delivery).toMatchObject({ status: 'failed', attempts: 6, nextAttempt: null });
    // Six tries, then nothing: the two extra sweeps found no due row.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('delivers once when two server instances sweep at the same moment', async () => {
    const { approval } = await decidedRequest();
    await queueDecisionWebhook(approval.id);

    const [a, b] = await Promise.all([deliverPending(), deliverPending()]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a.delivered + b.delivered).toBe(1);
  });

  it('retries a delivery whose sender died mid-send, once the claim lapses', async () => {
    const { approval } = await decidedRequest();
    const id = await queueDecisionWebhook(approval.id);
    // Another instance claimed it and never came back: its lease is still running.
    await prisma.webhookDelivery.update({
      where: { id: id! },
      data: { nextAttempt: new Date(Date.now() + 30_000) },
    });

    await deliverPending();
    expect(fetchMock).not.toHaveBeenCalled();

    await deliverPending(new Date(Date.now() + 61_000));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never makes a real network call in this suite', () => {
    expect(global.fetch).toBe(fetchMock);
  });
});

describe('startWebhookWorker', () => {
  it('returns a stop function and never holds the process open', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const stop = startWebhookWorker(1000);
    const timer = spy.mock.results[0].value as unknown as NodeJS.Timeout;

    expect(timer.hasRef()).toBe(false);
    stop();
    spy.mockRestore();
  });
});

// The sweeper lives beside the webhook worker: both are the background halves
// of a decision, and both must be safe to run on a timer.
describe('expiry sweeper', () => {
  it('closes overdue requests and leaves everything else alone', async () => {
    const { tenant } = await createTenant();
    const subject = await createSubject(tenant.id, 'cust_1');
    const base = {
      subjectId: subject.id,
      actorLabel: 'agent',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      title: 'Send an email',
      fieldsJson: '[]',
      argsHash: ARGS_HASH,
    };
    const overdue = await prisma.approvalRequest.create({
      data: { ...base, id: randomId('req'), code: '0001', expiresAt: new Date(Date.now() - 1000) },
    });
    const open = await prisma.approvalRequest.create({
      data: { ...base, id: randomId('req'), code: '0002', expiresAt: new Date(Date.now() + 60_000) },
    });
    const decided = await prisma.approvalRequest.create({
      data: {
        ...base,
        id: randomId('req'),
        code: '0003',
        status: 'approved',
        decidedAt: new Date(),
        expiresAt: new Date(Date.now() - 1000),
      },
    });

    expect(await expireOverdue(new Date())).toBe(1);
    // Running twice must not double-count: there is nothing left to close.
    expect(await expireOverdue(new Date())).toBe(0);

    const rows = await prisma.approvalRequest.findMany();
    const status = (id: string) => rows.find(r => r.id === id)!.status;
    expect(status(overdue.id)).toBe('expired');
    expect(status(open.id)).toBe('pending');
    expect(status(decided.id)).toBe('approved');
  });

  it('returns a stop function and never holds the process open', () => {
    const spy = jest.spyOn(global, 'setInterval');
    const stop = startExpirySweeper(1000);
    const timer = spy.mock.results[0].value as unknown as NodeJS.Timeout;

    expect(timer.hasRef()).toBe(false);
    stop();
    spy.mockRestore();
  });
});
