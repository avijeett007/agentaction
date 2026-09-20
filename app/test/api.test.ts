/**
 * The signed client: right URL, right headers, right signed message, and a
 * body that is hashed exactly as it is sent.
 */
import { ApiError, createDeviceClient, registerDevice } from '../lib/api';
import { deviceRequestMessage, sha256Hex } from '../lib/protocol';

const SERVER = 'https://approvals.example.com';
const DEVICE_ID = 'dev_abc123';
const FIXED_NOW = 1789862400123; // 2026-09-20T00:00:00.123Z
const FIXED_TS = '1789862400';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  } as unknown as Response;
}

function emptyResponse(status = 204): Response {
  return {
    ok: true,
    status,
    text: async () => '',
    json: async () => {
      throw new Error('no body');
    },
  } as unknown as Response;
}

function harness(response: Response | (() => Promise<Response>)) {
  const signed: string[] = [];
  const fetchImpl = jest.fn(async () =>
    typeof response === 'function' ? response() : response,
  ) as unknown as typeof fetch;

  const client = createDeviceClient({
    serverUrl: SERVER,
    deviceId: DEVICE_ID,
    signDevice: async message => {
      signed.push(message);
      return 'SIGNATURE';
    },
    fetchImpl,
    nowMs: () => FIXED_NOW,
  });

  return { client, fetchImpl: fetchImpl as unknown as jest.Mock, signed };
}

describe('listRequests', () => {
  it('GETs the collection with the three signature headers', async () => {
    const { client, fetchImpl, signed } = harness(
      jsonResponse({ requests: [{ id: 'req_1', title: 'Send an email' }] }),
    );

    const requests = await client.listRequests();

    expect(requests).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.example.com/v1/device/requests');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toMatchObject({
      'x-aa-device': DEVICE_ID,
      'x-aa-timestamp': FIXED_TS,
      'x-aa-signature': 'SIGNATURE',
    });
    // A GET carries no content-type; the server hashes an empty body.
    expect(init.headers['content-type']).toBeUndefined();
  });

  it('signs the path without the origin, and the hash of an empty body', async () => {
    const { client, signed } = harness(jsonResponse({ requests: [] }));
    await client.listRequests();

    expect(signed).toEqual([
      'GET\n/v1/device/requests\n1789862400\n' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    ]);
  });

  it('tolerates a response with no requests array', async () => {
    const { client } = harness(jsonResponse({}));
    await expect(client.listRequests()).resolves.toEqual([]);
  });

  it('strips a trailing slash from the server URL rather than double it', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ requests: [] })) as unknown as typeof fetch;
    const client = createDeviceClient({
      serverUrl: 'https://approvals.example.com/',
      deviceId: DEVICE_ID,
      signDevice: async () => 'S',
      fetchImpl,
      nowMs: () => FIXED_NOW,
    });

    await client.listRequests();
    expect((fetchImpl as unknown as jest.Mock).mock.calls[0][0]).toBe(
      'https://approvals.example.com/v1/device/requests',
    );
  });
});

describe('getRequest', () => {
  it('escapes the id in the path and signs that same path', async () => {
    const { client, fetchImpl, signed } = harness(
      jsonResponse({ request: { id: 'req 1', argsHash: 'aa', fields: [] } }),
    );

    await client.getRequest('req 1');

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://approvals.example.com/v1/device/requests/req%201',
    );
    expect(signed[0]).toBe(
      deviceRequestMessage('GET', '/v1/device/requests/req%201', FIXED_TS, ''),
    );
  });

  it('unwraps the request envelope', async () => {
    const { client } = harness(
      jsonResponse({ request: { id: 'req_1', title: 'Pay an invoice', argsHash: 'deadbeef', fields: [] } }),
    );
    await expect(client.getRequest('req_1')).resolves.toMatchObject({ argsHash: 'deadbeef' });
  });
});

describe('decide', () => {
  it('POSTs the decision and signs the hash of the exact bytes it sends', async () => {
    const { client, fetchImpl, signed } = harness(
      jsonResponse({ request: { id: 'req_1', status: 'approved' } }),
    );
    const input = {
      decision: 'approved' as const,
      scope: 'window' as const,
      signedAt: '2026-09-20T00:00:00.000Z',
      signature: 'APPROVAL_SIGNATURE',
    };

    await client.decide('req_1', input);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.example.com/v1/device/requests/req_1/decision');
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    // The body string is what the signature covers — re-serialising it later
    // could reorder keys and invalidate the signature.
    expect(init.body).toBe(JSON.stringify(input));
    expect(signed[0]).toBe(
      'POST\n/v1/device/requests/req_1/decision\n1789862400\n' + sha256Hex(init.body),
    );
  });
});

describe('updateSelf and unpair', () => {
  it('PATCHes the device with a JSON body', async () => {
    const { client, fetchImpl, signed } = harness(emptyResponse(200));

    await client.updateSelf({ label: "Avijit's iPhone", pushToken: 'ExponentPushToken[x]' });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.example.com/v1/devices/me');
    expect(init.method).toBe('PATCH');
    expect(signed[0].startsWith('PATCH\n/v1/devices/me\n1789862400\n')).toBe(true);
  });

  it('DELETEs the device with no body', async () => {
    const { client, fetchImpl, signed } = harness(emptyResponse(204));

    await client.unpair();

    expect(fetchImpl.mock.calls[0][1].method).toBe('DELETE');
    expect(fetchImpl.mock.calls[0][1].body).toBeUndefined();
    expect(signed[0]).toBe(
      'DELETE\n/v1/devices/me\n1789862400\n' +
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('accepts an empty 204 body without trying to parse it', async () => {
    const { client } = harness(emptyResponse(204));
    await expect(client.unpair()).resolves.toBeUndefined();
  });
});

describe('errors', () => {
  it('turns the server error envelope into an ApiError', async () => {
    const { client } = harness(
      jsonResponse({ error: { code: 'stale_signature', message: 'Signature timestamp out of range' } }, 401),
    );

    const error = await client.listRequests().catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 401, code: 'stale_signature' });
    expect((error as ApiError).isUnauthorised).toBe(true);
    expect((error as ApiError).message).toBe('Signature timestamp out of range');
  });

  it('copes with a gateway that answers with something other than JSON', async () => {
    const htmlResponse = {
      ok: false,
      status: 502,
      text: async () => '<html>bad gateway</html>',
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response;

    const { client } = harness(htmlResponse);
    await expect(client.listRequests()).rejects.toMatchObject({ status: 502, code: 'http_502' });
  });

  it('reports an unreachable server as an offline ApiError', async () => {
    const { client } = harness(async () => {
      throw new TypeError('Network request failed');
    });

    const error = await client.listRequests().catch((e: unknown) => e as ApiError);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).isOffline).toBe(true);
    expect((error as ApiError).message).toMatch(/Network request failed/);
  });
});

describe('registerDevice', () => {
  it('posts the pairing secret and both public keys, unsigned', async () => {
    const body = {
      device: { id: 'dev_1', label: "Avijit's iPhone" },
      subject: { label: 'ops@acme.com', externalId: 'cus_1' },
      tenant: { brandName: 'Acme', brandLogoUrl: null, brandColor: '#123456' },
    };
    const fetchImpl = jest.fn(async () => jsonResponse(body)) as unknown as typeof fetch;

    const result = await registerDevice(
      SERVER,
      {
        secret: 'pairing-secret',
        devicePubKey: 'DPK',
        approvalPubKey: 'APK',
        label: "Avijit's iPhone",
        platform: 'ios',
      },
      fetchImpl,
    );

    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0];
    expect(url).toBe('https://approvals.example.com/v1/devices/register');
    expect(init.method).toBe('POST');
    // No device signature: the keys being registered do not exist yet.
    expect(init.headers['x-aa-signature']).toBeUndefined();
    expect(JSON.parse(init.body)).toMatchObject({ secret: 'pairing-secret', devicePubKey: 'DPK' });
    expect(result.tenant.brandColor).toBe('#123456');
  });

  it('surfaces a rejected pairing secret', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ error: { code: 'pairing_expired', message: 'That code has expired' } }, 400),
    ) as unknown as typeof fetch;

    await expect(
      registerDevice(SERVER, { secret: 's', devicePubKey: 'a', approvalPubKey: 'b', label: 'l', platform: 'ios' }, fetchImpl),
    ).rejects.toMatchObject({ code: 'pairing_expired', status: 400 });
  });
});
