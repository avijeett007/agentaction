import { AgentActionClient, AgentActionError, AgentActionOperator } from '../src/index';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const TENANT = {
  id: 'ten_1',
  name: 'Acme Agency',
  brandName: 'Acme',
  brandLogoUrl: null,
  brandColor: '#3B82F6',
  webhookUrl: 'https://integrator.test/approvals/decision/org_1',
  deviceCap: 5,
  requestTtlSec: 600,
  maxGrantWindowSec: 900,
};

describe('AgentActionOperator.createTenant', () => {
  it('creates a tenant with the admin key and returns its key and secret', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(
        jsonResponse(201, { tenant: TENANT, apiKey: 'aa_live_new', webhookSecret: 'whsec_new' }),
      );
    const operator = new AgentActionOperator({
      baseUrl: 'https://approvals.test/',
      adminApiKey: 'admin_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await operator.createTenant({ name: 'Acme Agency', brandName: 'Acme' });

    expect(result).toEqual({ tenant: TENANT, apiKey: 'aa_live_new', webhookSecret: 'whsec_new' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.test/v1/tenants');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer admin_secret');
    expect(JSON.parse(init.body)).toEqual({ name: 'Acme Agency', brandName: 'Acme' });
  });

  it('never retries a create, even on a 5xx, so it cannot make two tenants', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(503, { error: { code: 'unavailable', message: 'down' } }));
    const operator = new AgentActionOperator({
      baseUrl: 'https://approvals.test',
      adminApiKey: 'admin_secret',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(operator.createTenant({ name: 'A', brandName: 'A' })).rejects.toBeInstanceOf(
      AgentActionError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('AgentActionClient tenant calls', () => {
  function client(fetchImpl: jest.Mock) {
    return new AgentActionClient({
      baseUrl: 'https://approvals.test',
      apiKey: 'aa_live_tenant',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  it('reads the tenant this key belongs to', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { tenant: TENANT }));

    await expect(client(fetchImpl).getTenant()).resolves.toEqual(TENANT);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.test/v1/tenants/me');
    expect(init.headers.authorization).toBe('Bearer aa_live_tenant');
  });

  it('updates only the fields given', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValue(jsonResponse(200, { tenant: { ...TENANT, brandName: 'Acme Ltd' } }));

    const tenant = await client(fetchImpl).updateTenant({ brandName: 'Acme Ltd' });

    expect(tenant.brandName).toBe('Acme Ltd');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://approvals.test/v1/tenants/me');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body)).toEqual({ brandName: 'Acme Ltd' });
  });
});
