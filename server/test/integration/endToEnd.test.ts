import request from 'supertest';
import { createApp } from '../../src/app';
import { prisma } from '../../src/prisma';
import { decisionMessage } from '../../src/lib/crypto';
import { deliverPending } from '../../src/services/webhooks';
import { resetDb } from '../helpers/db';
import { deviceHeaders, makeKeyPair } from '../helpers/keys';

/**
 * One journey through the real HTTP surface, in the order a phone and a
 * gateway actually make the calls. The per-lane suites prove each endpoint;
 * this proves they fit together — a mismatch between, say, what the phone
 * signs and what the decision endpoint verifies would pass every other test
 * and still leave nothing working.
 */

const app = createApp();
const ADMIN_KEY = 'e2e-admin-key';
const WEBHOOK_URL = 'https://hub.test/api/approvals/decision';

beforeEach(async () => {
  await resetDb();
  process.env.ADMIN_API_KEY = ADMIN_KEY;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('pair a phone, park a call, approve it', () => {
  it('carries one tool call from request to signed approval and out to the webhook', async () => {
    // 1. The operator creates the agency's tenant.
    const tenantRes = await request(app)
      .post('/v1/tenants')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Acme Agency', brandName: 'Acme', webhookUrl: WEBHOOK_URL });
    expect(tenantRes.status).toBe(201);
    const apiKey: string = tenantRes.body.apiKey;
    const webhookSecret: string = tenantRes.body.webhookSecret;

    // 2. The portal asks for a pairing code for this customer.
    const pairingRes = await request(app)
      .post('/v1/pairings')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: 'cust_42', label: 'Acme Dental', email: 'owner@acme.test' });
    expect(pairingRes.status).toBe(201);
    const { qrPayload, pairing } = pairingRes.body;
    expect(qrPayload.brand.name).toBe('Acme');
    expect(qrPayload.subject.label).toBe('Acme Dental');

    // 3. The phone scans it and registers the two keys it just generated.
    const deviceKeys = makeKeyPair();
    const approvalKeys = makeKeyPair();
    const registerRes = await request(app).post('/v1/devices/register').send({
      secret: qrPayload.secret,
      devicePubKey: deviceKeys.publicKey,
      approvalPubKey: approvalKeys.publicKey,
      label: "Owner's iPhone",
      platform: 'ios',
      pushToken: 'ExponentPushToken[e2e]',
    });
    expect(registerRes.status).toBe(201);
    const deviceId: string = registerRes.body.device.id;
    expect(registerRes.body.tenant.brandName).toBe('Acme');

    // The portal sees the phone appear.
    const pairingState = await request(app)
      .get(`/v1/pairings/${pairing.id}`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(pairingState.body.pairing.status).toBe('used');

    // 4. The customer gates a tool.
    const ruleRes = await request(app)
      .put('/v1/policies/subject')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: 'cust_42', resourceKey: 'gmail/GMAIL_SEND_EMAIL', enabled: true });
    expect(ruleRes.status).toBe(200);

    // 5. The gateway asks whether this call needs a human. It does.
    const evaluateRes = await request(app)
      .post('/v1/policies/evaluate')
      .set('authorization', `Bearer ${apiKey}`)
      .send({ externalId: 'cust_42', resourceKey: 'gmail/GMAIL_SEND_EMAIL' });
    expect(evaluateRes.body).toMatchObject({ gated: true, reason: 'customer' });

    // 6. So it parks the call and asks for approval.
    const argsHash = 'a'.repeat(64);
    const createRes = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send({
        externalId: 'cust_42',
        actorLabel: 'Claude Code',
        resourceKey: 'gmail/GMAIL_SEND_EMAIL',
        // The title is generic on purpose: it becomes the push body, which is
        // readable on a locked phone. The specifics live in `fields`.
        title: 'Send email via Gmail',
        fields: [
          { label: 'To', value: 'patient@example.com' },
          { label: 'Subject', value: 'Your appointment' },
        ],
        argsHash,
      });
    expect(createRes.status).toBe(201);
    const requestId: string = createRes.body.request.id;
    expect(createRes.body.request.code).toMatch(/^\d{4}$/);

    // 7. The phone lists what is waiting, then opens it.
    const listPath = '/v1/device/requests';
    const listRes = await request(app)
      .get(listPath)
      .set(deviceHeaders(deviceId, deviceKeys, 'GET', listPath));
    expect(listRes.status).toBe(200);
    expect(listRes.body.requests).toHaveLength(1);
    expect(listRes.body.requests[0].actorLabel).toBe('Claude Code');
    // Neither the list nor the title it carries may expose an argument value:
    // both reach the phone before it is unlocked.
    expect(JSON.stringify(listRes.body)).not.toContain('patient@example.com');
    expect(listRes.body.requests[0].title).toBe('Send email via Gmail');

    const detailPath = `${listPath}/${requestId}`;
    const detailRes = await request(app)
      .get(detailPath)
      .set(deviceHeaders(deviceId, deviceKeys, 'GET', detailPath));
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.request.fields).toEqual([
      expect.objectContaining({ label: 'To', value: 'patient@example.com' }),
      expect.objectContaining({ label: 'Subject', value: 'Your appointment' }),
    ]);
    const storedHash: string = detailRes.body.request.argsHash;
    expect(storedHash).toBe(argsHash);

    // 8. The owner approves: the approval key signs the stored argument hash.
    const signedAt = String(Math.floor(Date.now() / 1000));
    const body = {
      decision: 'approved' as const,
      scope: 'once' as const,
      signedAt,
      signature: approvalKeys.sign(
        decisionMessage({
          requestId,
          decision: 'approved',
          scope: 'once',
          argsHash: storedHash,
          signedAt,
        }),
      ),
    };
    const decisionPath = `${detailPath}/decision`;
    const decisionRes = await request(app)
      .post(decisionPath)
      .set(deviceHeaders(deviceId, deviceKeys, 'POST', decisionPath, body))
      .send(body);
    expect(decisionRes.status).toBe(200);
    expect(decisionRes.body.request.status).toBe('approved');

    // 9. The gateway's long-poll returns the decision.
    const waitRes = await request(app)
      .get(`/v1/requests/${requestId}/wait?timeout=2`)
      .set('authorization', `Bearer ${apiKey}`);
    expect(waitRes.body.request.status).toBe('approved');

    // 10. And the webhook goes out, signed, carrying the same hash.
    const fetchMock = jest.fn().mockResolvedValue(new Response('', { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const result = await deliverPending(new Date());
    expect(result.delivered).toBe(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(WEBHOOK_URL);
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody).toMatchObject({
      type: 'request.decided',
      requestId,
      subjectExternalId: 'cust_42',
      status: 'approved',
      argsHash,
    });

    // The receiving end must be able to verify it with the tenant's secret.
    const { verifyWebhookSignature } = await import('../../src/lib/crypto');
    const header = (init.headers as Record<string, string>)['x-agentaction-signature'];
    expect(verifyWebhookSignature(webhookSecret, header, init.body as string)).toBe(true);
    expect(verifyWebhookSignature('wrong-secret', header, init.body as string)).toBe(false);
  });

  it('refuses a decision signed by a phone paired to another customer', async () => {
    const tenantRes = await request(app)
      .post('/v1/tenants')
      .set('authorization', `Bearer ${ADMIN_KEY}`)
      .send({ name: 'Acme', brandName: 'Acme' });
    const apiKey: string = tenantRes.body.apiKey;

    async function pairPhone(externalId: string) {
      const pairingRes = await request(app)
        .post('/v1/pairings')
        .set('authorization', `Bearer ${apiKey}`)
        .send({ externalId, label: externalId });
      const deviceKeys = makeKeyPair();
      const approvalKeys = makeKeyPair();
      const res = await request(app).post('/v1/devices/register').send({
        secret: pairingRes.body.qrPayload.secret,
        devicePubKey: deviceKeys.publicKey,
        approvalPubKey: approvalKeys.publicKey,
        label: 'phone',
        platform: 'android',
      });
      return { deviceId: res.body.device.id as string, deviceKeys, approvalKeys };
    }

    const mine = await pairPhone('cust_a');
    const theirs = await pairPhone('cust_b');

    const createRes = await request(app)
      .post('/v1/requests')
      .set('authorization', `Bearer ${apiKey}`)
      .send({
        externalId: 'cust_a',
        actorLabel: 'agent',
        resourceKey: 'gmail/SEND',
        title: 'Send email',
        fields: [],
        argsHash: 'b'.repeat(64),
      });
    const requestId: string = createRes.body.request.id;

    // The other customer's phone cannot even see it...
    const detailPath = `/v1/device/requests/${requestId}`;
    const peek = await request(app)
      .get(detailPath)
      .set(deviceHeaders(theirs.deviceId, theirs.deviceKeys, 'GET', detailPath));
    expect(peek.status).toBe(404);

    // ...nor decide it, even with a perfectly valid signature of its own.
    const signedAt = String(Math.floor(Date.now() / 1000));
    const body = {
      decision: 'approved' as const,
      scope: 'once' as const,
      signedAt,
      signature: theirs.approvalKeys.sign(
        decisionMessage({
          requestId,
          decision: 'approved',
          scope: 'once',
          argsHash: 'b'.repeat(64),
          signedAt,
        }),
      ),
    };
    const decisionPath = `${detailPath}/decision`;
    const res = await request(app)
      .post(decisionPath)
      .set(deviceHeaders(theirs.deviceId, theirs.deviceKeys, 'POST', decisionPath, body))
      .send(body);
    expect(res.status).toBe(404);

    const stored = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
    expect(stored?.status).toBe('pending');
    expect(mine.deviceId).not.toBe(theirs.deviceId);
  });
});
