/** Shapes exchanged with the AgentAction approval server. */

export interface Brand {
  name: string;
  logoUrl: string | null;
  color: string;
}

export interface PairingPayload {
  v: 1;
  serverUrl: string;
  secret: string;
  tenantId: string;
  brand: Brand;
  subject: { label: string };
}

export interface CreatePairingResult {
  pairing: { id: string; expiresAt: string };
  /** Render this as a QR code. It contains the one-time pairing secret. */
  qrPayload: PairingPayload;
}

export type PairingStatus = 'pending' | 'used' | 'expired';

export interface PairingState {
  id: string;
  status: PairingStatus;
  expiresAt: string;
  usedAt: string | null;
}

export interface DeviceSummary {
  id: string;
  label: string;
  platform: string;
  model: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  pushEnabled: boolean;
}

/** One line shown on the approval screen. Keep values short and human. */
export interface ApprovalField {
  label: string;
  value: string;
  sensitive?: boolean;
}

export interface CreateApprovalRequestInput {
  /** The integrator's own id for the account — your own customer or user id. */
  externalId: string;
  /** Which agent asked, as the person would recognise it. */
  actorLabel: string;
  /** "<app>/<tool>", e.g. "gmail/GMAIL_SEND_EMAIL". */
  resourceKey: string;
  /**
   * A generic action label such as "Send email via Gmail". It becomes the push
   * notification body, which is readable on a locked phone, so it must never
   * contain argument values — those belong in `fields`.
   */
  title: string;
  fields: ApprovalField[];
  /** Hash of the canonical arguments; the phone signs it, so nothing can change. */
  argsHash: string;
  ttlSec?: number;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface ApprovalRequestState {
  id: string;
  status: ApprovalStatus;
  code: string;
  resourceKey?: string;
  title?: string;
  argsHash?: string;
  expiresAt: string;
  createdAt?: string;
  decidedAt?: string | null;
  decisionScope?: 'once' | 'window' | null;
  decidedByDeviceId?: string | null;
}

export interface CreateApprovalRequestResult {
  request: ApprovalRequestState;
  /** True when an identical request was already waiting, so no second push went out. */
  deduplicated?: boolean;
}

export type PolicyReason = 'locked' | 'customer' | 'default' | 'off' | 'grant';

export interface PolicyEvaluation {
  gated: boolean;
  reason: PolicyReason;
  matchedKey?: string;
}

export interface EffectivePolicy {
  resourceKey: string;
  gated: boolean;
  reason: PolicyReason;
  locked: boolean;
  customerSetting: boolean | null;
  tenantDefault: boolean | null;
}

/** One of the agency's own rows: a default, and whether it is locked. */
export interface TenantPolicy {
  resourceKey: string;
  enabled: boolean;
  locked: boolean;
  scope: 'tenant';
}

export interface SubjectInput {
  externalId: string;
  label: string;
  email?: string;
}

export interface DecisionWebhookEvent {
  type: 'request.decided';
  requestId: string;
  subjectExternalId: string;
  resourceKey: string;
  status: ApprovalStatus;
  decisionScope: 'once' | 'window' | null;
  argsHash: string;
  decidedAt: string;
}
