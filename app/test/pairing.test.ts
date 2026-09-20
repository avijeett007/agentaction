/**
 * Parsing a scanned QR code.
 *
 * A QR code is untrusted input — anyone can print one on a poster and leave it
 * where a customer will scan it — and whoever controls `serverUrl` controls
 * which server receives the pairing secret and every signed call afterwards.
 * The URL cases below are the ones a prefix match would wave through.
 */
import { normaliseBrand, parsePairingPayload, safeServerUrl } from '../lib/pairing';
import { NEUTRAL_BRAND } from '../lib/theme';

const valid = {
  v: 1,
  serverUrl: 'https://approvals.example.com',
  secret: 'a-pairing-secret-long-enough',
  tenantId: 'ten_123',
  brand: { name: 'Acme', logoUrl: 'https://cdn.example.com/logo.png', color: '#3355FF' },
  subject: { label: 'ops@acme.com' },
};

const qr = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({ ...valid, ...overrides });

describe('safeServerUrl', () => {
  it('accepts https on any host', () => {
    expect(safeServerUrl('https://approvals.example.com')).toBe('https://approvals.example.com');
    expect(safeServerUrl('https://approvals.example.com/base/')).toBe(
      'https://approvals.example.com/base',
    );
    expect(safeServerUrl('https://approvals.example.com:8443')).toBe(
      'https://approvals.example.com:8443',
    );
  });

  it('accepts plain http only on loopback and private addresses', () => {
    expect(safeServerUrl('http://localhost:4890')).toBe('http://localhost:4890');
    expect(safeServerUrl('http://127.0.0.1:4890')).toBe('http://127.0.0.1:4890');
    expect(safeServerUrl('http://10.0.0.5:4890')).toBe('http://10.0.0.5:4890');
    expect(safeServerUrl('http://192.168.1.10:4890')).toBe('http://192.168.1.10:4890');
  });

  it('rejects hosts that merely start with an allowed prefix', () => {
    // These are the bypasses a regex allowlist lets through: the allowed name
    // is a prefix of an attacker-controlled domain, not the whole host.
    expect(safeServerUrl('http://10.evil.com')).toBeNull();
    expect(safeServerUrl('http://localhost.evil.com')).toBeNull();
    expect(safeServerUrl('http://127.0.0.1.evil.com')).toBeNull();
    expect(safeServerUrl('http://192.168.1.10.evil.com')).toBeNull();
    expect(safeServerUrl('http://localhost.evil.com/v1')).toBeNull();
  });

  it('rejects a URL whose real host hides behind userinfo', () => {
    // The host here is evil.com; "trusted" is a username.
    expect(safeServerUrl('https://trusted@evil.com')).toBeNull();
    expect(safeServerUrl('https://trusted@evil.com/')).toBeNull();
    expect(safeServerUrl('http://localhost@evil.com')).toBeNull();
    expect(safeServerUrl('https://user:pass@evil.com')).toBeNull();
  });

  it('rejects any scheme that is not http or https', () => {
    expect(safeServerUrl('javascript:alert(1)')).toBeNull();
    expect(safeServerUrl('file:///etc/passwd')).toBeNull();
    expect(safeServerUrl('data:text/html,hi')).toBeNull();
    expect(safeServerUrl('ftp://example.com')).toBeNull();
  });

  it('rejects plain http on a public host', () => {
    expect(safeServerUrl('http://approvals.example.com')).toBeNull();
    expect(safeServerUrl('http://11.0.0.1')).toBeNull();
    expect(safeServerUrl('http://192.169.1.1')).toBeNull();
  });

  it('rejects strings that are not URLs at all', () => {
    expect(safeServerUrl('approvals.example.com')).toBeNull();
    expect(safeServerUrl('')).toBeNull();
    expect(safeServerUrl('   ')).toBeNull();
    expect(safeServerUrl('not a url')).toBeNull();
  });

  it('rejects whitespace and backslashes used to confuse a parser', () => {
    expect(safeServerUrl('https://evil.com\\@approvals.example.com')).toBeNull();
    expect(safeServerUrl('https://approvals.example.com\n')).toBeNull();
  });

  it('treats a trailing dot as the same host, not as a different one', () => {
    // "localhost." is the fully-qualified form of "localhost" and resolves to
    // loopback, so it is allowed — but the dot must not become a way to
    // smuggle another domain past the check.
    expect(safeServerUrl('http://localhost./v1')).toBe('http://localhost./v1');
    expect(safeServerUrl('http://10.0.0.5.:4890')).toBe('http://10.0.0.5.:4890');
    expect(safeServerUrl('http://localhost.evil.com.')).toBeNull();
    expect(safeServerUrl('http://10.0.0.5.evil.com.')).toBeNull();
  });

  it('drops the query and fragment, which are never part of the server URL', () => {
    expect(safeServerUrl('https://approvals.example.com/?next=evil')).toBe(
      'https://approvals.example.com',
    );
    expect(safeServerUrl('https://approvals.example.com/base#x')).toBe(
      'https://approvals.example.com/base',
    );
  });
});

describe('parsePairingPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(parsePairingPayload(qr())).toEqual({
      v: 1,
      serverUrl: 'https://approvals.example.com',
      secret: 'a-pairing-secret-long-enough',
      tenantId: 'ten_123',
      brand: { name: 'Acme', logoUrl: 'https://cdn.example.com/logo.png', color: '#3355FF' },
      subject: { label: 'ops@acme.com' },
    });
  });

  it('normalises the server URL', () => {
    expect(parsePairingPayload(qr({ serverUrl: 'https://approvals.example.com/' })).serverUrl).toBe(
      'https://approvals.example.com',
    );
  });

  it('refuses a payload pointing at an unsafe server', () => {
    expect(() => parsePairingPayload(qr({ serverUrl: 'http://10.evil.com' }))).toThrow(/unsafe/);
    expect(() => parsePairingPayload(qr({ serverUrl: 'https://trusted@evil.com' }))).toThrow(/unsafe/);
    expect(() => parsePairingPayload(qr({ serverUrl: 42 }))).toThrow(/unsafe/);
  });

  it('refuses anything that is not our payload', () => {
    expect(() => parsePairingPayload('hello')).toThrow(/not an AgentAction pairing code/);
    expect(() => parsePairingPayload('https://example.com')).toThrow(/not an AgentAction/);
    expect(() => parsePairingPayload('null')).toThrow(/not an AgentAction/);
  });

  it('refuses a version it does not understand', () => {
    expect(() => parsePairingPayload(qr({ v: 2 }))).toThrow(/newer version/);
    expect(() => parsePairingPayload(qr({ v: undefined }))).toThrow(/newer version/);
  });

  it('refuses an incomplete payload', () => {
    expect(() => parsePairingPayload(qr({ secret: 'short' }))).toThrow(/incomplete/);
    expect(() => parsePairingPayload(qr({ secret: undefined }))).toThrow(/incomplete/);
    expect(() => parsePairingPayload(qr({ tenantId: '' }))).toThrow(/incomplete/);
    expect(() => parsePairingPayload(qr({ subject: {} }))).toThrow(/account it belongs to/);
    expect(() => parsePairingPayload(qr({ subject: undefined }))).toThrow(/account it belongs to/);
  });
});

describe('normaliseBrand', () => {
  // The fallback is AgentAction's own identity — the blue the app wears before
  // anything is paired — rather than a second, unrelated grey.
  it('falls back to the neutral brand when fields are missing', () => {
    expect(normaliseBrand(undefined)).toEqual({
      name: 'AgentAction',
      logoUrl: null,
      color: '#5B8CFF',
    });
    expect(normaliseBrand(undefined)).toEqual(NEUTRAL_BRAND);
  });

  it('keeps only a hex colour', () => {
    expect(normaliseBrand({ name: 'A', logoUrl: null, color: '#abc' }).color).toBe('#abc');
    expect(normaliseBrand({ name: 'A', logoUrl: null, color: 'red' }).color).toBe('#5B8CFF');
    expect(
      normaliseBrand({ name: 'A', logoUrl: null, color: 'javascript:alert(1)' }).color,
    ).toBe('#5B8CFF');
  });

  it('keeps only an https logo, so branding cannot downgrade the connection', () => {
    expect(normaliseBrand({ name: 'A', logoUrl: 'http://cdn.example.com/l.png', color: '#fff' }).logoUrl).toBeNull();
    expect(normaliseBrand({ name: 'A', logoUrl: 'https://cdn.example.com/l.png', color: '#fff' }).logoUrl).toBe(
      'https://cdn.example.com/l.png',
    );
  });
});
