import crypto from 'crypto';

/** Stable JSON: object keys sorted at every level, so two callers that build
 *  the same value always produce the same bytes (RFC 8785 in spirit). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** The hash the phone signs and the gateway re-checks before it runs anything. */
export function hashArgs(args: unknown): string {
  return sha256Hex(canonicalJson(args));
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export function randomSecret(bytes = 32): string {
  return base64url(crypto.randomBytes(bytes));
}

/** 4 digits, uniformly distributed (rejection sampling, no modulo bias). */
export function numericCode(digits = 4): string {
  const max = 10 ** digits;
  const limit = Math.floor(0xffffffff / max) * max;
  let n: number;
  do {
    n = crypto.randomBytes(4).readUInt32BE(0);
  } while (n >= limit);
  return String(n % max).padStart(digits, '0');
}

export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64url(value: string): Buffer {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** An integrator API key. The plain key is returned once; only the hash is stored. */
export function generateApiKey(): { key: string; hash: string } {
  const key = `aa_live_${crypto.randomBytes(24).toString('hex')}`;
  return { key, hash: sha256Hex(key) };
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/**
 * Verify an Ed25519 signature made by a phone.
 * `publicKey` is the raw 32-byte key, base64url — what the app registers.
 */
export function verifyEd25519(publicKey: string, message: string, signature: string): boolean {
  try {
    const raw = fromBase64url(publicKey);
    if (raw.length !== 32) return false;
    const key = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: base64url(raw) } as crypto.JsonWebKey,
      format: 'jwk',
    });
    const sig = fromBase64url(signature);
    if (sig.length !== 64) return false;
    return crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/** What a device signs to authenticate one API call. */
export function deviceRequestMessage(
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return [method.toUpperCase(), path, timestamp, sha256Hex(body || '')].join('\n');
}

/**
 * What a device signs to approve or deny. Binds the decision to the arguments
 * *and* to the length of the grant it creates.
 *
 * `windowSec` is inside the signature deliberately. If the duration travelled
 * beside the signature instead, anything able to rewrite the request in flight
 * could turn a five-minute grant into an eight-hour one without touching a
 * single signed byte — the same class of attack the argument hash exists to
 * stop.
 *
 * `once` signs `windowSec = 0` rather than leaving the field out, so the
 * message always has the same seven lines and there is exactly one way to
 * build it. A builder that omitted the line would produce two shapes, and two
 * shapes is how a verifier ends up guessing.
 *
 * The version is `v2` because of that extra line: a v1 decision (six lines, no
 * window) cannot verify here, so an older phone fails closed instead of
 * quietly receiving whatever window the server would have picked.
 */
export function decisionMessage(input: {
  requestId: string;
  decision: string;
  scope: string;
  /** Seconds the grant will last; 0 when the scope is `once`. */
  windowSec: number;
  argsHash: string;
  signedAt: string;
}): string {
  return [
    'agentaction.decision.v2',
    input.requestId,
    input.decision,
    input.scope,
    String(input.windowSec),
    input.argsHash,
    input.signedAt,
  ].join('\n');
}

/** Outbound webhook signature: `t=<unix>,v1=<hex hmac of "t.body">`. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  header: string,
  body: string,
  toleranceSec = 300,
  now = Date.now(),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map(p => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return timingSafeEqual(expected, parts.v1);
}
