import crypto from 'crypto';
import type {
  ApprovalRequestState,
  CreateApprovalRequestInput,
  CreateApprovalRequestResult,
  CreatePairingResult,
  CreateTenantInput,
  CreateTenantResult,
  DecisionWebhookEvent,
  DeviceSummary,
  EffectivePolicy,
  PairingState,
  PolicyEvaluation,
  SubjectInput,
  TenantPolicy,
  TenantSummary,
  UpdateTenantInput,
} from './types';

export * from './types';

/**
 * Anything the caller can act on. `unavailable` is the one that matters most:
 * it means we could not reach the approval server, so a caller that gates a
 * risky action must refuse the action rather than let it through.
 */
export class AgentActionError extends Error {
  constructor(
    public code: string,
    message: string,
    public status?: number,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AgentActionError';
  }

  get unavailable(): boolean {
    return this.code === 'unavailable' || this.code === 'timeout';
  }
}

export interface AgentActionClientOptions {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout. The long-poll helper sets its own, longer, budget. */
  timeoutMs?: number;
  /** Retries for reads only; writes are never retried automatically. */
  retries?: number;
  fetchImpl?: typeof fetch;
}

/** Where and how to send: shared by the integrator and operator clients. */
interface Transport {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
  retries: number;
  fetchImpl: typeof fetch;
}

function transportFrom(options: {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}): Transport {
  return {
    baseUrl: options.baseUrl.replace(/\/+$/, ''),
    apiKey: options.apiKey,
    timeoutMs: options.timeoutMs ?? 5000,
    retries: options.retries ?? 1,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
  };
}

export interface AgentActionOperatorOptions {
  baseUrl: string;
  /** The approval server's ADMIN_API_KEY. Keep it out of anything a customer can reach. */
  adminApiKey: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class AgentActionClient {
  private readonly transport: Transport;

  constructor(options: AgentActionClientOptions) {
    this.transport = transportFrom(options);
  }

  // ---- tenant -------------------------------------------------------------

  /** The tenant this API key belongs to: its brand, webhook and limits. */
  async getTenant(): Promise<TenantSummary> {
    const res = await this.call<{ tenant: TenantSummary }>('GET', '/v1/tenants/me');
    return res.tenant;
  }

  /**
   * Change this tenant's brand, webhook target or limits. Only the fields
   * given are changed. Push the brand again whenever the organisation renames
   * itself, so the phone and the agent name the same app.
   */
  async updateTenant(input: UpdateTenantInput): Promise<TenantSummary> {
    const res = await this.call<{ tenant: TenantSummary }>('PATCH', '/v1/tenants/me', input);
    return res.tenant;
  }

  // ---- subjects -----------------------------------------------------------

  /** Create or update the account a phone will be paired to. Idempotent. */
  async upsertSubject(input: SubjectInput): Promise<{ id: string; externalId: string }> {
    const res = await this.call<{ subject: { id: string; externalId: string } }>(
      'PUT',
      '/v1/tenants/me/subjects',
      input,
    );
    return res.subject;
  }

  // ---- pairing and devices ------------------------------------------------

  async createPairing(input: SubjectInput): Promise<CreatePairingResult> {
    return this.call<CreatePairingResult>('POST', '/v1/pairings', input);
  }

  async getPairing(pairingId: string): Promise<PairingState> {
    const res = await this.call<{ pairing: PairingState }>(
      'GET',
      `/v1/pairings/${encodeURIComponent(pairingId)}`,
    );
    return res.pairing;
  }

  async listDevices(externalId: string): Promise<DeviceSummary[]> {
    const res = await this.call<{ devices: DeviceSummary[] }>(
      'GET',
      `/v1/devices?externalId=${encodeURIComponent(externalId)}`,
    );
    return res.devices;
  }

  async revokeDevice(deviceId: string): Promise<void> {
    await this.call('DELETE', `/v1/devices/${encodeURIComponent(deviceId)}`);
  }

  // ---- approvals ----------------------------------------------------------

  async createRequest(input: CreateApprovalRequestInput): Promise<CreateApprovalRequestResult> {
    return this.call<CreateApprovalRequestResult>('POST', '/v1/requests', input);
  }

  async getRequest(requestId: string): Promise<ApprovalRequestState> {
    const res = await this.call<{ request: ApprovalRequestState }>(
      'GET',
      `/v1/requests/${encodeURIComponent(requestId)}`,
    );
    return res.request;
  }

  /**
   * Long-poll until the request is decided or `timeoutSec` passes. The server
   * answers as soon as the status changes, so this is not a busy loop.
   */
  async waitForRequest(requestId: string, timeoutSec = 30): Promise<ApprovalRequestState> {
    const capped = Math.min(Math.max(timeoutSec, 1), 50);
    const res = await this.call<{ request: ApprovalRequestState }>(
      'GET',
      `/v1/requests/${encodeURIComponent(requestId)}/wait?timeout=${capped}`,
      undefined,
      { timeoutMs: (capped + 5) * 1000 },
    );
    return res.request;
  }

  // ---- policy -------------------------------------------------------------

  /** The question the gateway asks on every tool call: does this need a human? */
  async evaluate(externalId: string, resourceKey: string): Promise<PolicyEvaluation> {
    return this.call<PolicyEvaluation>('POST', '/v1/policies/evaluate', {
      externalId,
      resourceKey,
    });
  }

  async listPolicies(externalId: string): Promise<EffectivePolicy[]> {
    const res = await this.call<{ policies: EffectivePolicy[] }>(
      'GET',
      `/v1/policies?externalId=${encodeURIComponent(externalId)}`,
    );
    return res.policies;
  }

  async setSubjectPolicy(
    externalId: string,
    resourceKey: string,
    enabled: boolean,
  ): Promise<EffectivePolicy> {
    const res = await this.call<{ policy: EffectivePolicy }>('PUT', '/v1/policies/subject', {
      externalId,
      resourceKey,
      enabled,
    });
    return res.policy;
  }

  /** The agency's own defaults and locks — no subject involved. */
  async listTenantPolicies(): Promise<TenantPolicy[]> {
    const res = await this.call<{ policies: TenantPolicy[] }>('GET', '/v1/policies/tenant');
    return res.policies;
  }

  async setTenantPolicy(
    resourceKey: string,
    enabled: boolean,
    locked: boolean,
  ): Promise<TenantPolicy> {
    const res = await this.call<{ policy: TenantPolicy }>('PUT', '/v1/policies/tenant', {
      resourceKey,
      enabled,
      locked,
    });
    return res.policy;
  }

  // ---- transport ----------------------------------------------------------

  private call<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return send<T>(this.transport, method, path, body, options);
  }
}

/**
 * The operator's client: the one party that creates tenants.
 *
 * Running AgentAction for several organisations — each with its own brand,
 * rules, phones and webhook — means creating one tenant per organisation with
 * the server's `ADMIN_API_KEY`. The tenant's API key and webhook secret come
 * back from `createTenant` once and can never be read again: store both
 * encrypted, keyed by your organisation's id, before doing anything else.
 * See docs/multi-tenancy.md.
 */
export class AgentActionOperator {
  private readonly transport: Transport;

  constructor(options: AgentActionOperatorOptions) {
    // Never retried: a repeated create would make a second tenant.
    this.transport = transportFrom({ ...options, apiKey: options.adminApiKey, retries: 0 });
  }

  async createTenant(input: CreateTenantInput): Promise<CreateTenantResult> {
    return send<CreateTenantResult>(this.transport, 'POST', '/v1/tenants', input);
  }
}

async function send<T>(
t: Transport,
method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const url = `${t.baseUrl}${path}`;
  const timeoutMs = options.timeoutMs ?? t.timeoutMs;
  // Only reads are safe to repeat: replaying a write could create a second
  // approval request and a second push.
  const attempts = method === 'GET' ? t.retries + 1 : 1;

  let lastError: AgentActionError | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await t.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${t.apiKey}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const payload = await safeJson(res);
        const error = payload?.error as { code?: string; message?: string; details?: unknown };
        const apiError = new AgentActionError(
          error?.code ?? `http_${res.status}`,
          error?.message ?? `Request failed with status ${res.status}`,
          res.status,
          error?.details,
        );
        // A 5xx may be a blip; a 4xx is our own fault and will not improve.
        if (res.status >= 500 && attempt < attempts - 1) {
          lastError = apiError;
          continue;
        }
        throw apiError;
      }

      return (await safeJson(res)) as T;
    } catch (err) {
      if (err instanceof AgentActionError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      lastError = new AgentActionError(
        isAbort ? 'timeout' : 'unavailable',
        isAbort
          ? `Approval server did not answer within ${timeoutMs}ms`
          : `Could not reach the approval server: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (attempt === attempts - 1) throw lastError;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError ?? new AgentActionError('unavailable', 'Could not reach the approval server');
}

/**
 * Verify a decision webhook before trusting a word of it.
 * `header` is the `x-agentaction-signature` value, `body` the RAW request body.
 */
export function verifyWebhook(
  secret: string,
  header: string | undefined,
  body: string,
  toleranceSec = 300,
  now: number = Date.now(),
): boolean {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const piece of header.split(',')) {
    const i = piece.indexOf('=');
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts.v1);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify and parse in one step; throws if the signature does not check out. */
export function parseWebhook(
  secret: string,
  header: string | undefined,
  body: string,
  now: number = Date.now(),
): DecisionWebhookEvent {
  if (!verifyWebhook(secret, header, body, 300, now)) {
    throw new AgentActionError('bad_signature', 'Webhook signature did not verify');
  }
  return JSON.parse(body) as DecisionWebhookEvent;
}

/** Canonical JSON + sha256, matching what the server and the phone hash. */
export function hashArgs(args: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(args)).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

async function safeJson(res: Response): Promise<Record<string, unknown> | undefined> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
