/**
 * Stands in for the phone, over the network, against the running server.
 *
 * The app's own unit tests check the signing bytes; this checks the same
 * protocol across a real HTTP hop: register two keys with a pairing secret,
 * list what is waiting, read one, and sign an approval. If this passes, a
 * failure on the real device is the device's doing, not the protocol's.
 */
import crypto from 'crypto';

const BASE = process.env.BASE ?? 'http://localhost:4890';
const API_KEY = process.env.API_KEY;
const SECRET = process.env.SECRET;
const SUBJECT = process.env.SUBJECT ?? 'customer-1';

const b64url = buf =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha256Hex = s => crypto.createHash('sha256').update(s).digest('hex');

function makeKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'jwk' }).x,
    sign: msg => b64url(crypto.sign(null, Buffer.from(msg, 'utf8'), privateKey)),
  };
}

function deviceHeaders(deviceId, keys, method, path, body) {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const message = [method.toUpperCase(), path, ts, sha256Hex(raw)].join('\n');
  return {
    'x-aa-device': deviceId,
    'x-aa-timestamp': ts,
    'x-aa-signature': keys.sign(message),
    'content-type': 'application/json',
  };
}

const ok = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
};

const deviceKeys = makeKeys();
const approvalKeys = makeKeys();

// 1. Register, exactly as the app does after reading the pairing code.
const reg = await fetch(`${BASE}/v1/devices/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    secret: SECRET,
    devicePubKey: deviceKeys.publicKey,
    approvalPubKey: approvalKeys.publicKey,
    label: 'Protocol check (not a real phone)',
    platform: 'android',
  }),
}).then(r => r.json());
ok('device registers with the pairing secret', !!reg.device?.id, reg.error?.message ?? reg.tenant?.brandName);
const deviceId = reg.device.id;

// 2. The gateway parks a call.
const created = await fetch(`${BASE}/v1/requests`, {
  method: 'POST',
  headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    externalId: SUBJECT,
    actorLabel: 'Claude Code',
    resourceKey: 'gmail/GMAIL_SEND_EMAIL',
    title: 'Send email via Gmail',
    fields: [
      { label: 'To', value: 'patient@example.com' },
      { label: 'Subject', value: 'Your appointment' },
    ],
    argsHash: 'a'.repeat(64),
  }),
}).then(r => r.json());
ok('gateway can park a call', !!created.request?.id, `code ${created.request?.code}`);
const requestId = created.request.id;

// 3. The phone lists what is waiting.
const listPath = '/v1/device/requests';
const list = await fetch(`${BASE}${listPath}`, {
  headers: deviceHeaders(deviceId, deviceKeys, 'GET', listPath),
}).then(r => r.json());
ok('phone lists it with a signed request', list.requests?.length === 1);
ok('the list carries no argument values', !JSON.stringify(list).includes('patient@example.com'));

// 4. And opens it.
const detailPath = `${listPath}/${requestId}`;
const detail = await fetch(`${BASE}${detailPath}`, {
  headers: deviceHeaders(deviceId, deviceKeys, 'GET', detailPath),
}).then(r => r.json());
ok('opening it shows the arguments', detail.request?.fields?.[0]?.value === 'patient@example.com');

/** The seven lines the phone signs. `windowSec` is 0 unless a window is granted. */
const decisionMessage = (id, decision, scope, windowSec, argsHash, signedAt) =>
  [
    'agentaction.decision.v2',
    id,
    decision,
    scope,
    String(windowSec),
    argsHash,
    signedAt,
  ].join('\n');

/** Parks one more call, so each decision below is made on a fresh request. */
async function park(hash) {
  const res = await fetch(`${BASE}/v1/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      externalId: SUBJECT,
      actorLabel: 'Claude Code',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      title: 'Send email via Gmail',
      fields: [{ label: 'To', value: 'patient@example.com' }],
      argsHash: hash,
    }),
  }).then(r => r.json());
  return res.request.id;
}

function decide(id, body) {
  const path = `/v1/device/requests/${id}/decision`;
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: deviceHeaders(deviceId, deviceKeys, 'POST', path, body),
    body: JSON.stringify(body),
  });
}

// 5. Approve — the approval key signs the hash the server holds.
const signedAt = String(Math.floor(Date.now() / 1000));
const body = {
  decision: 'approved',
  scope: 'once',
  windowSec: 0,
  signedAt,
  signature: approvalKeys.sign(
    decisionMessage(requestId, 'approved', 'once', 0, detail.request.argsHash, signedAt),
  ),
};
const decided = await decide(requestId, body).then(r => r.json());
ok('the signed approval is accepted', decided.request?.status === 'approved', decided.error?.message ?? '');
ok('approving once grants nothing', decided.grant === null);

// 6. The gateway sees it.
const seen = await fetch(`${BASE}/v1/requests/${requestId}`, {
  headers: { authorization: `Bearer ${API_KEY}` },
}).then(r => r.json());
ok('the gateway sees the approval', seen.request?.status === 'approved');

// 7. A chosen window comes back as a grant of exactly that length.
const windowHash = 'b'.repeat(64);
const windowId = await park(windowHash);
const windowAt = String(Math.floor(Date.now() / 1000));
const windowBody = {
  decision: 'approved',
  scope: 'window',
  windowSec: 300,
  signedAt: windowAt,
  signature: approvalKeys.sign(
    decisionMessage(windowId, 'approved', 'window', 300, windowHash, windowAt),
  ),
};
const windowed = await decide(windowId, windowBody).then(r => r.json());
ok(
  'a five-minute window is granted as five minutes',
  windowed.grant?.windowSec === 300 || windowed.grant?.clamped === true,
  windowed.grant ? `granted ${windowed.grant.windowSec}s, cap ${windowed.grant.maxWindowSec}s` : windowed.error?.message,
);

// 8. A signature made over a *different* window must not be accepted: this is
//    the whole reason the duration is inside the signed message.
const tamperHash = 'c'.repeat(64);
const tamperId = await park(tamperHash);
const tamperAt = String(Math.floor(Date.now() / 1000));
const tamperBody = {
  decision: 'approved',
  scope: 'window',
  windowSec: 28800, // sent
  signedAt: tamperAt,
  signature: approvalKeys.sign(
    decisionMessage(tamperId, 'approved', 'window', 300, tamperHash, tamperAt), // signed
  ),
};
const tampered = await decide(tamperId, tamperBody);
ok('a window widened after signing is refused', tampered.status === 401, `HTTP ${tampered.status}`);
