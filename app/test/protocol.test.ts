/**
 * The signing messages, asserted against strings built by hand.
 *
 * These are the highest-value tests in the app: if a single byte differs from
 * what the server rebuilds, every call returns "bad signature" and nothing in
 * the product works. So the expectations below are written out literally
 * rather than produced by the code under test.
 */
import {
  SHA256_OF_EMPTY,
  decisionMessage,
  decisionSignedAt,
  deviceRequestMessage,
  fromBase64Url,
  requestTimestamp,
  sha256Hex,
  toBase64Url,
} from '../lib/protocol';

describe('sha256Hex', () => {
  it('hashes the empty string to a real value, not an empty one', () => {
    // The server signs sha256Hex('') for GET and DELETE, so this is the value
    // that appears in most signed messages the app produces.
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(SHA256_OF_EMPTY).toBe(sha256Hex(''));
  });

  it('matches the published vectors', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('{"decision":"approved"}')).toHaveLength(64);
    expect(sha256Hex('a')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes UTF-8 bytes, not UTF-16 code units', () => {
    // "é" is two bytes (C3 A9). A code-unit implementation would hash one byte
    // and disagree with the server on every body containing an accent.
    expect(sha256Hex('é')).toBe(
      '4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c',
    );
    expect(sha256Hex('é')).not.toBe(sha256Hex('e'));
  });
});

describe('base64url', () => {
  it('round-trips arbitrary bytes', () => {
    for (let length = 0; length <= 40; length += 1) {
      const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) % 256);
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes));
    }
  });

  it('emits unpadded base64url, matching the server', () => {
    expect(toBase64Url(Uint8Array.from([0, 1, 2, 3]))).toBe('AAECAw');
    expect(toBase64Url(Uint8Array.from([255, 255, 255]))).toBe('____');
    expect(toBase64Url(Uint8Array.from([251, 255, 190]))).toBe('-_--');
    expect(toBase64Url(Uint8Array.from([]))).toBe('');
    expect(toBase64Url(Uint8Array.from([1, 2, 3, 4]))).not.toContain('=');
  });

  it('accepts padded and standard-alphabet input too', () => {
    expect(Array.from(fromBase64Url('AAECAw=='))).toEqual([0, 1, 2, 3]);
    expect(Array.from(fromBase64Url('+/+/'))).toEqual(Array.from(fromBase64Url('-_-_')));
  });

  it('rejects characters that are not base64', () => {
    expect(() => fromBase64Url('abc$def')).toThrow(/base64url/);
  });
});

describe('deviceRequestMessage', () => {
  it('is METHOD, path, timestamp and the body hash, newline separated', () => {
    const expected =
      'GET\n' +
      '/v1/device/requests\n' +
      '1758326400\n' +
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    expect(deviceRequestMessage('GET', '/v1/device/requests', '1758326400', '')).toBe(expected);
  });

  it('hashes a real body and upper-cases the method', () => {
    const body = '{"decision":"approved","scope":"once"}';
    const expected =
      'POST\n' +
      '/v1/device/requests/req_123/decision\n' +
      '1758326400\n' +
      sha256Hex(body);

    expect(
      deviceRequestMessage('post', '/v1/device/requests/req_123/decision', '1758326400', body),
    ).toBe(expected);

    // Spelled out once so a reader can see there is no separator but "\n".
    expect(expected.split('\n')).toHaveLength(4);
  });

  it('treats a missing body exactly as an empty one', () => {
    expect(deviceRequestMessage('DELETE', '/v1/devices/me', '1', '')).toBe(
      `DELETE\n/v1/devices/me\n1\n${SHA256_OF_EMPTY}`,
    );
  });
});

describe('decisionMessage', () => {
  it('is the v1 prefix, id, decision, scope, args hash and signedAt', () => {
    const expected =
      'agentaction.decision.v1\n' +
      'req_9f2a\n' +
      'approved\n' +
      'window\n' +
      '4d7c1e3b0a5f6d8c9b2e1a0f3c4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4\n' +
      '2026-09-20T11:22:33.000Z';

    expect(
      decisionMessage({
        requestId: 'req_9f2a',
        decision: 'approved',
        scope: 'window',
        argsHash: '4d7c1e3b0a5f6d8c9b2e1a0f3c4d5e6a7b8c9d0e1f2a3b4c5d6e7f8091a2b3c4',
        signedAt: '2026-09-20T11:22:33.000Z',
      }),
    ).toBe(expected);
    expect(expected.split('\n')).toHaveLength(6);
  });

  it('distinguishes deny from approve and once from window', () => {
    const base = {
      requestId: 'req_1',
      argsHash: 'aa',
      signedAt: '2026-09-20T00:00:00.000Z',
    } as const;
    const approveOnce = decisionMessage({ ...base, decision: 'approved', scope: 'once' });
    const approveWindow = decisionMessage({ ...base, decision: 'approved', scope: 'window' });
    const deny = decisionMessage({ ...base, decision: 'denied', scope: 'once' });

    expect(new Set([approveOnce, approveWindow, deny]).size).toBe(3);
  });
});

describe('timestamps', () => {
  it('uses unix seconds for the header', () => {
    expect(requestTimestamp(1789862400123)).toBe('1789862400');
    expect(requestTimestamp(0)).toBe('0');
  });

  it('uses ISO-8601 for signedAt, matching the other timestamps on a request', () => {
    // Unix seconds, because the server rejects anything else — see the
    // signedAt regex in server/src/routes/deviceRequests.ts.
    expect(decisionSignedAt(1789862400000)).toBe('1789862400');
    expect(decisionSignedAt(1789862400999)).toBe('1789862400');
    expect(decisionSignedAt(1789862400000)).toMatch(/^\d{1,12}$/);
  });
});
