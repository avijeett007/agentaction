import crypto from 'crypto';
import {
  canonicalJson,
  hashArgs,
  numericCode,
  verifyEd25519,
  signWebhook,
  verifyWebhookSignature,
  decisionMessage,
  generateApiKey,
  sha256Hex,
} from '../../src/lib/crypto';
import { makeKeyPair } from '../helpers/keys';

describe('canonicalJson', () => {
  it('orders keys so the same value always hashes the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(hashArgs({ to: 'x@y.z', subject: 'Hi' })).toBe(hashArgs({ subject: 'Hi', to: 'x@y.z' }));
  });

  it('separates values that only differ in nesting', () => {
    expect(hashArgs({ a: { b: 1 } })).not.toBe(hashArgs({ a: 1, b: 1 }));
  });

  it('drops undefined but keeps null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('numericCode', () => {
  it('always returns four digits', () => {
    for (let i = 0; i < 200; i++) expect(numericCode()).toMatch(/^\d{4}$/);
  });
});

describe('verifyEd25519', () => {
  it('accepts a genuine signature and rejects a tampered message', () => {
    const keys = makeKeyPair();
    const sig = keys.sign('hello');
    expect(verifyEd25519(keys.publicKey, 'hello', sig)).toBe(true);
    expect(verifyEd25519(keys.publicKey, 'hello!', sig)).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const a = makeKeyPair();
    const b = makeKeyPair();
    expect(verifyEd25519(b.publicKey, 'hello', a.sign('hello'))).toBe(false);
  });

  it('rejects malformed keys and signatures instead of throwing', () => {
    const keys = makeKeyPair();
    expect(verifyEd25519('not-a-key', 'hello', keys.sign('hello'))).toBe(false);
    expect(verifyEd25519(keys.publicKey, 'hello', 'not-a-signature')).toBe(false);
  });

  it('binds a decision to its request, verdict, arguments and window', () => {
    const keys = makeKeyPair();
    const base = {
      requestId: 'req_1',
      decision: 'approved',
      scope: 'window',
      windowSec: 300,
      argsHash: 'abc',
      signedAt: '1700000000',
    };
    const sig = keys.sign(decisionMessage(base));
    expect(verifyEd25519(keys.publicKey, decisionMessage(base), sig)).toBe(true);
    expect(
      verifyEd25519(keys.publicKey, decisionMessage({ ...base, argsHash: 'changed' }), sig),
    ).toBe(false);
    expect(
      verifyEd25519(keys.publicKey, decisionMessage({ ...base, decision: 'denied' }), sig),
    ).toBe(false);
    // The one this change exists for: five minutes signed, eight hours sent.
    expect(
      verifyEd25519(keys.publicKey, decisionMessage({ ...base, windowSec: 28800 }), sig),
    ).toBe(false);
  });

  it('spells the decision message out, field by field', () => {
    // Written literally rather than built, because the app rebuilds these exact
    // bytes from its own copy of the builder (app/lib/protocol.ts).
    expect(
      decisionMessage({
        requestId: 'req_9f2a',
        decision: 'approved',
        scope: 'window',
        windowSec: 900,
        argsHash: 'aa',
        signedAt: '1700000000',
      }),
    ).toBe('agentaction.decision.v2\nreq_9f2a\napproved\nwindow\n900\naa\n1700000000');

    // `once` signs a literal 0 rather than dropping the line, so every message
    // has the same seven fields.
    expect(
      decisionMessage({
        requestId: 'req_9f2a',
        decision: 'approved',
        scope: 'once',
        windowSec: 0,
        argsHash: 'aa',
        signedAt: '1700000000',
      }),
    ).toBe('agentaction.decision.v2\nreq_9f2a\napproved\nonce\n0\naa\n1700000000');
  });
});

describe('webhook signatures', () => {
  const secret = 'shhh';
  const body = JSON.stringify({ hello: 'world' });

  it('verifies what it signs', () => {
    const now = Date.now();
    const header = signWebhook(secret, Math.floor(now / 1000), body);
    expect(verifyWebhookSignature(secret, header, body, 300, now)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret and a stale timestamp', () => {
    const now = Date.now();
    const header = signWebhook(secret, Math.floor(now / 1000), body);
    expect(verifyWebhookSignature(secret, header, '{"hello":"there"}', 300, now)).toBe(false);
    expect(verifyWebhookSignature('other', header, body, 300, now)).toBe(false);
    expect(verifyWebhookSignature(secret, header, body, 300, now + 10 * 60 * 1000)).toBe(false);
  });

  it('rejects a header that is missing parts', () => {
    expect(verifyWebhookSignature(secret, 't=123', body)).toBe(false);
    expect(verifyWebhookSignature(secret, 'garbage', body)).toBe(false);
  });
});

describe('generateApiKey', () => {
  it('returns a prefixed key whose stored form is only its hash', () => {
    const { key, hash } = generateApiKey();
    expect(key.startsWith('aa_live_')).toBe(true);
    expect(hash).toBe(sha256Hex(key));
    expect(hash).not.toContain(key);
  });

  it('never repeats', () => {
    const keys = new Set(Array.from({ length: 50 }, () => generateApiKey().key));
    expect(keys.size).toBe(50);
  });
});

describe('node crypto assumptions', () => {
  it('can rebuild a raw base64url ed25519 key as a JWK', () => {
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    expect(Buffer.from(jwk.x, 'base64url')).toHaveLength(32);
  });
});
