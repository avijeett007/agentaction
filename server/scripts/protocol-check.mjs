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

// 5. Approve — the approval key signs the hash the server holds.
const signedAt = String(Math.floor(Date.now() / 1000));
const decisionMessage = [
  'agentaction.decision.v1',
  requestId,
  'approved',
  'once',
  detail.request.argsHash,
  signedAt,
].join('\n');
const body = {
  decision: 'approved',
  scope: 'once',
  signedAt,
  signature: approvalKeys.sign(decisionMessage),
};
const decisionPath = `${detailPath}/decision`;
const decided = await fetch(`${BASE}${decisionPath}`, {
  method: 'POST',
  headers: deviceHeaders(deviceId, deviceKeys, 'POST', decisionPath, body),
  body: JSON.stringify(body),
}).then(r => r.json());
ok('the signed approval is accepted', decided.request?.status === 'approved', decided.error?.message ?? '');

// 6. The gateway sees it.
const seen = await fetch(`${BASE}/v1/requests/${requestId}`, {
  headers: { authorization: `Bearer ${API_KEY}` },
}).then(r => r.json());
ok('the gateway sees the approval', seen.request?.status === 'approved');

// 7. A tampered signature must not be accepted.
const badBody = { ...body, signature: approvalKeys.sign(decisionMessage.replace('once', 'window')) };
const bad = await fetch(`${BASE}/v1/device/requests/${requestId}/decision`, {
  method: 'POST',
  headers: deviceHeaders(deviceId, deviceKeys, 'POST', decisionPath, badBody),
  body: JSON.stringify(badBody),
});
ok('a mismatched signature is refused', bad.status >= 400, `HTTP ${bad.status}`);
