import crypto from 'crypto';
import {
  AgentActionClient,
  AgentActionError,
  canonicalJson,
  hashArgs,
  parseWebhook,
  verifyWebhook,
} from '../src/index';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeClient(fetchImpl: jest.Mock, overrides: Partial<{ retries: number; timeoutMs: number }> = {}) {
  return new AgentActionClient({
    baseUrl: 'https://approvals.test/',
    apiKey: 'aa_live_test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
}

describe('requests', () => {
  it('posts an approval request with the API key and returns the parsed body', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(
      jsonResponse(201, {
        request: { id: 'req_1', status: 'pending', code: '4821', expiresAt: 'later' },
      }),
    );
    const client = makeClient(fetchImpl);

    const result = await client.createRequest({
      externalId: 'cust_1',
      actorLabel: 'Claude Code',
      resourceKey: 'gmail/GMAIL_SEND_EMAIL',
      title: 'Send email',
      fields: [{ label: 'To', value: 'a@b.c' }],
      argsHash: 'abc',
    });

    expect(result.request.code).toBe('4821');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.test/v1/requests');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer aa_live_test');
    expect(JSON.parse(init.body).resourceKey).toBe('gmail/GMAIL_SEND_EMAIL');
  });

  it('caps the long-poll timeout the server is asked for', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { request: { id: 'req_1', status: 'approved' } }));
    const client = makeClient(fetchImpl);

    await client.waitForRequest('req_1', 600);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://approvals.test/v1/requests/req_1/wait?timeout=50');
  });

  it('escapes ids in paths', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { request: {} }));
    await makeClient(fetchImpl).getRequest('req/../../admin');
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://approvals.test/v1/requests/req%2F..%2F..%2Fadmin',
    );
  });
});

describe('failure handling', () => {
  it('reports an unreachable server as unavailable so callers can fail closed', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const client = makeClient(fetchImpl, { retries: 0 });

    const error = await client
      .evaluate('cust_1', 'gmail/SEND')
      .catch((e: AgentActionError) => e);

    expect(error).toBeInstanceOf(AgentActionError);
    expect((error as AgentActionError).code).toBe('unavailable');
    expect((error as AgentActionError).unavailable).toBe(true);
  });

  it('reports a timeout as unavailable too', async () => {
    const fetchImpl = jest.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const client = makeClient(fetchImpl, { timeoutMs: 10, retries: 0 });

    const error = (await client.getRequest('req_1').catch(e => e)) as AgentActionError;
    expect(error.code).toBe('timeout');
    expect(error.unavailable).toBe(true);
  });

  it('surfaces the server error code and does not retry a 4xx', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(409, { error: { code: 'policy_locked', message: 'Locked by agency' } }),
      );
    const client = makeClient(fetchImpl);

    const error = (await client
      .setSubjectPolicy('cust_1', 'gmail/SEND', false)
      .catch(e => e)) as AgentActionError;

    expect(error.code).toBe('policy_locked');
    expect(error.status).toBe(409);
    expect(error.unavailable).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a read once on a 5xx but never retries a write', async () => {
    const readFetch = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: { code: 'unavailable' } }))
      .mockResolvedValueOnce(jsonResponse(200, { devices: [] }));
    await makeClient(readFetch).listDevices('cust_1');
    expect(readFetch).toHaveBeenCalledTimes(2);

    const writeFetch = jest
      .fn()
      .mockResolvedValue(jsonResponse(500, { error: { code: 'internal_error' } }));
    await expect(
      makeClient(writeFetch).createRequest({
        externalId: 'c',
        actorLabel: 'a',
        resourceKey: 'app/tool',
        title: 't',
        fields: [],
        argsHash: 'h',
      }),
    ).rejects.toBeInstanceOf(AgentActionError);
    expect(writeFetch).toHaveBeenCalledTimes(1);
  });
});

describe('webhooks', () => {
  const secret = 'tenant-secret';
  const event = {
    type: 'request.decided',
    requestId: 'req_1',
    subjectExternalId: 'cust_1',
    resourceKey: 'gmail/GMAIL_SEND_EMAIL',
    status: 'approved',
    decisionScope: 'once',
    argsHash: 'abc',
    decidedAt: '2026-09-20T01:00:00.000Z',
  };
  const body = JSON.stringify(event);

  function sign(at: number, payload = body, withSecret = secret): string {
    const mac = crypto.createHmac('sha256', withSecret).update(`${at}.${payload}`).digest('hex');
    return `t=${at},v1=${mac}`;
  }

  it('accepts a genuine signature', () => {
    const now = Date.now();
    expect(verifyWebhook(secret, sign(Math.floor(now / 1000)), body, 300, now)).toBe(true);
  });

  it('rejects a tampered body, a wrong secret, a stale timestamp and a missing header', () => {
    const now = Date.now();
    const header = sign(Math.floor(now / 1000));
    expect(verifyWebhook(secret, header, body.replace('approved', 'denied'), 300, now)).toBe(false);
    expect(verifyWebhook('other', header, body, 300, now)).toBe(false);
    expect(verifyWebhook(secret, header, body, 300, now + 10 * 60 * 1000)).toBe(false);
    expect(verifyWebhook(secret, undefined, body, 300, now)).toBe(false);
    expect(verifyWebhook(secret, 'v1=deadbeef', body, 300, now)).toBe(false);
  });

  it('parses only after the signature checks out', () => {
    const now = Date.now();
    expect(parseWebhook(secret, sign(Math.floor(now / 1000)), body, now).requestId).toBe('req_1');
    expect(() => parseWebhook(secret, 't=1,v1=bad', body, now)).toThrow(AgentActionError);
  });
});

describe('hashArgs', () => {
  it('ignores key order and matches a hand-computed hash', () => {
    expect(hashArgs({ b: 2, a: 1 })).toBe(hashArgs({ a: 1, b: 2 }));
    const expected = crypto.createHash('sha256').update('{"a":1,"b":2}').digest('hex');
    expect(hashArgs({ b: 2, a: 1 })).toBe(expected);
  });

  it('serialises nested values stably', () => {
    expect(canonicalJson({ z: [3, { y: 1, x: 2 }] })).toBe('{"z":[3,{"x":2,"y":1}]}');
  });
});
