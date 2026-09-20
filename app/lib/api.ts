/**
 * The AgentAction server client.
 *
 * Every call after pairing is authenticated by an Ed25519 signature over the
 * method, path, timestamp and body hash — there is no bearer token on the
 * phone that could be lifted and replayed from somewhere else.
 */
import { deviceRequestMessage, requestTimestamp } from './protocol';
import type { DecisionScope, DecisionValue } from './protocol';

export type { DecisionScope, DecisionValue };

/** Anything that went wrong, with enough detail to show the owner. */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The phone could not reach the server at all (offline, DNS, TLS). */
  get isOffline(): boolean {
    return this.status === 0;
  }

  /** The server no longer knows this device — the account should be dropped. */
  get isUnauthorised(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface TenantBranding {
  brandName: string;
  brandLogoUrl: string | null;
  brandColor: string;
}

export interface RegisterDeviceInput {
  /** The one-time secret out of the pairing QR code. */
  secret: string;
  devicePubKey: string;
  approvalPubKey: string;
  label: string;
  platform: string;
  model?: string;
  pushToken?: string | null;
}

export interface RegisterDeviceResponse {
  device: { id: string; label: string };
  subject: { label: string; externalId: string };
  tenant: TenantBranding;
}

export interface PendingRequest {
  id: string;
  title: string;
  /** Four digits, shown to the agent as well, so the owner can match them. */
  code: string;
  resourceKey: string;
  actorLabel: string;
  expiresAt: string;
  createdAt: string;
  brandName: string;
}

export interface RequestField {
  label: string;
  value: string;
  sensitive: boolean;
}

export interface RequestDetail extends PendingRequest {
  /** Binds a decision to the exact arguments the gateway will run. */
  argsHash: string;
  fields: RequestField[];
  status?: string;
}

export interface DecisionInput {
  decision: DecisionValue;
  scope: DecisionScope;
  signedAt: string;
  /** Made with the biometric-gated approval key. */
  signature: string;
}

export interface DecisionResponse {
  request: { id: string; status: string; decidedAt?: string };
}

export interface DevicePatch {
  label?: string;
  pushToken?: string | null;
}

type SignMessage = (message: string) => Promise<string>;

export interface DeviceClientOptions {
  serverUrl: string;
  deviceId: string;
  /** Signs with the *device* key — no biometric prompt. */
  signDevice: SignMessage;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

function joinUrl(serverUrl: string, path: string): string {
  return `${serverUrl.replace(/\/+$/, '')}${path}`;
}

async function readError(res: Response): Promise<ApiError> {
  let code = `http_${res.status}`;
  let message = `Request failed (${res.status})`;
  let details: unknown;
  try {
    const body = (await res.json()) as { error?: { code?: string; message?: string; details?: unknown } };
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // A proxy or gateway may answer with HTML; the status alone will do.
  }
  return new ApiError(res.status, code, message, details);
}

async function readJson<T>(res: Response): Promise<T> {
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Pairing is the one unsigned call: the QR secret is what proves the caller
 * may attach a device, and the keys being registered do not exist yet.
 */
export async function registerDevice(
  serverUrl: string,
  input: RegisterDeviceInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisterDeviceResponse> {
  const path = '/v1/devices/register';
  let res: Response;
  try {
    res = await fetchImpl(joinUrl(serverUrl, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new ApiError(0, 'network_error', describeNetworkError(err));
  }
  if (!res.ok) throw await readError(res);
  return readJson<RegisterDeviceResponse>(res);
}

function describeNetworkError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Could not reach the approval server (${detail})`;
}

export interface DeviceClient {
  listRequests(): Promise<PendingRequest[]>;
  getRequest(id: string): Promise<RequestDetail>;
  decide(id: string, input: DecisionInput): Promise<DecisionResponse>;
  updateSelf(patch: DevicePatch): Promise<void>;
  unpair(): Promise<void>;
}

export function createDeviceClient(options: DeviceClientOptions): DeviceClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const nowMs = options.nowMs ?? Date.now;

  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    // The body is stringified exactly once: the server hashes the bytes it
    // received, so re-stringifying could quietly change key order and break
    // the signature.
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = requestTimestamp(nowMs());
    const signature = await options.signDevice(
      deviceRequestMessage(method, path, timestamp, raw),
    );

    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-aa-device': options.deviceId,
      'x-aa-timestamp': timestamp,
      'x-aa-signature': signature,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetchImpl(joinUrl(options.serverUrl, path), {
        method,
        headers,
        body: body === undefined ? undefined : raw,
      });
    } catch (err) {
      throw new ApiError(0, 'network_error', describeNetworkError(err));
    }
    if (!res.ok) throw await readError(res);
    return readJson<T>(res);
  }

  return {
    async listRequests() {
      const body = await send<{ requests: PendingRequest[] }>('GET', '/v1/device/requests');
      return body?.requests ?? [];
    },
    async getRequest(id) {
      const body = await send<{ request: RequestDetail }>(
        'GET',
        `/v1/device/requests/${encodeURIComponent(id)}`,
      );
      return body.request;
    },
    decide(id, input) {
      return send<DecisionResponse>(
        'POST',
        `/v1/device/requests/${encodeURIComponent(id)}/decision`,
        input,
      );
    },
    async updateSelf(patch) {
      await send<void>('PATCH', '/v1/devices/me', patch);
    },
    async unpair() {
      await send<void>('DELETE', '/v1/devices/me');
    },
  };
}
