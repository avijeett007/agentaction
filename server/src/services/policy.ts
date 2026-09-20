import type { Grant, Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { config } from '../config';
import { randomId } from '../lib/crypto';

/**
 * Which tool calls need a human.
 *
 * A rule is `(subject, resourceKey, enabled)`. `resourceKey` is `"<app>/<tool>"`
 * — `gmail/GMAIL_SEND_EMAIL` — or the app wildcard `"<app>/*"`.
 *
 * Rows with `subjectId = null` belong to the agency (the tenant): `enabled` is
 * the default its customers inherit, and `locked` means the customer may not
 * switch it off. Rows with a `subjectId` are that customer's own choice.
 *
 * This file is deliberately free of Express so the rules can be exercised
 * directly, and so the gateway may call them from anywhere.
 */

export type PolicyReason = 'locked' | 'customer' | 'default' | 'off' | 'grant';

export interface PolicyDecision {
  /** True when the call must wait for a human. */
  gated: boolean;
  reason: PolicyReason;
  /** The rule that decided it — useful when a wildcard answered for a tool. */
  matchedKey?: string;
}

export interface EffectivePolicy {
  resourceKey: string;
  gated: boolean;
  reason: PolicyReason;
  /** True when the agency rule that applies here is locked. */
  locked: boolean;
  /** The customer's own answer for this key, or null when they have not set one. */
  customerSetting: boolean | null;
  /** The agency answer that applies here, or null when the agency is silent. */
  tenantDefault: boolean | null;
}

/** A row from either level, reduced to what the precedence rules care about. */
interface RuleRow {
  resourceKey: string;
  enabled: boolean;
  locked: boolean;
}

/** `gmail/GMAIL_SEND_EMAIL` → `gmail/*`. A key with no slash is its own wildcard. */
export function wildcardKeyFor(resourceKey: string): string {
  const slash = resourceKey.indexOf('/');
  return slash === -1 ? resourceKey : `${resourceKey.slice(0, slash)}/*`;
}

/**
 * The keys that may decide a call, most specific first: the tool itself, then
 * its app wildcard. Asking for a wildcard yields just the one key.
 */
export function candidateKeys(resourceKey: string): string[] {
  const wildcard = wildcardKeyFor(resourceKey);
  return wildcard === resourceKey ? [resourceKey] : [resourceKey, wildcard];
}

/**
 * The row that wins inside one level. Exactness beats breadth everywhere: an
 * agency that writes a row for one tool has said something more deliberate
 * than its blanket `app/*` row, and the same holds for a customer.
 */
export function pickMostSpecific<T extends { resourceKey: string }>(
  rows: readonly T[],
  keys: readonly string[],
): T | undefined {
  for (const key of keys) {
    const hit = rows.find(row => row.resourceKey === key);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * The precedence, in one place:
 *
 *   1. a live grant — someone already said "allow this for a while";
 *   2. a locked agency rule — the customer cannot argue with it;
 *   3. the customer's own rule;
 *   4. the agency default;
 *   5. nothing, so nothing is gated. Silence never blocks a tool call.
 *
 * A locked `gmail/*` therefore still beats a customer's exact row — locking is
 * the whole point of the feature — while an *unlocked* agency row for the exact
 * tool reads as a deliberate carve-out from the agency's own wildcard, and the
 * customer is free to decide that one.
 */
export function decide(input: {
  resourceKey: string;
  grants: readonly { resourceKey: string }[];
  tenantRows: readonly RuleRow[];
  subjectRows: readonly RuleRow[];
}): PolicyDecision {
  const keys = candidateKeys(input.resourceKey);

  const grant = pickMostSpecific(input.grants, keys);
  if (grant) return { gated: false, reason: 'grant', matchedKey: grant.resourceKey };

  const tenantRow = pickMostSpecific(input.tenantRows, keys);
  if (tenantRow?.locked) {
    return { gated: tenantRow.enabled, reason: 'locked', matchedKey: tenantRow.resourceKey };
  }

  const subjectRow = pickMostSpecific(input.subjectRows, keys);
  if (subjectRow) {
    return { gated: subjectRow.enabled, reason: 'customer', matchedKey: subjectRow.resourceKey };
  }

  if (tenantRow) {
    return { gated: tenantRow.enabled, reason: 'default', matchedKey: tenantRow.resourceKey };
  }

  return { gated: false, reason: 'off' };
}

/**
 * Both levels of rules plus the live grants for one subject, in a single call.
 *
 * The gateway asks this on every tool call, so it is one round trip: the
 * subject lookup, the customer's rows, the agency's rows and the grants all
 * come back together. An unknown subject returns null rather than creating
 * anything — a customer who has never paired must not find their tools blocked.
 *
 * Rows come back newest first so that if two agency rows for the same key ever
 * race into existence (the database cannot make `subjectId = null` unique), the
 * most recent write is the one that decides.
 */
async function loadRules(where: Prisma.SubjectWhereUniqueInput, keys: string[] | null, now: Date) {
  const keyFilter = keys ? { resourceKey: { in: keys } } : {};
  const subject = await prisma.subject.findUnique({
    where,
    select: {
      id: true,
      tenantId: true,
      policies: { where: keyFilter, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      grants: { where: { ...keyFilter, expiresAt: { gt: now } }, orderBy: { expiresAt: 'desc' } },
      tenant: {
        select: {
          policies: {
            where: { subjectId: null, ...keyFilter },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          },
        },
      },
    },
  });
  if (!subject) return null;
  return {
    subjectId: subject.id,
    tenantId: subject.tenantId,
    subjectRows: subject.policies,
    tenantRows: subject.tenant.policies,
    grants: subject.grants,
  };
}

/** The three row sets `decide` needs, without the ids that surround them. */
function pickRows(rules: NonNullable<Awaited<ReturnType<typeof loadRules>>>) {
  return { grants: rules.grants, tenantRows: rules.tenantRows, subjectRows: rules.subjectRows };
}

/** What happens if this subject's agent calls this tool right now. */
export async function resolvePolicy(
  subjectId: string,
  resourceKey: string,
  now: Date = new Date(),
): Promise<PolicyDecision> {
  const rules = await loadRules({ id: subjectId }, candidateKeys(resourceKey), now);
  if (!rules) return { gated: false, reason: 'off' };
  return decide({ resourceKey, ...pickRows(rules) });
}

/**
 * The same answer for a subject the caller knows by the integrator's own id.
 * Scoped to the tenant, so one agency can never evaluate another's customer,
 * and unknown to us means ungated.
 */
export async function evaluateForExternalId(input: {
  tenantId: string;
  externalId: string;
  resourceKey: string;
  now?: Date;
}): Promise<PolicyDecision> {
  const now = input.now ?? new Date();
  const rules = await loadRules(
    { tenantId_externalId: { tenantId: input.tenantId, externalId: input.externalId } },
    candidateKeys(input.resourceKey),
    now,
  );
  if (!rules) return { gated: false, reason: 'off' };
  return decide({ resourceKey: input.resourceKey, ...pickRows(rules) });
}

/**
 * Every rule that touches this subject, from either level, with the answer the
 * portal should show. Grants are honoured here too, so the list tells the truth
 * about what would happen now; `customerSetting` and `tenantDefault` still
 * carry the stored rows, which is what a toggle renders from.
 */
export async function listEffectivePolicies(
  subjectId: string,
  now: Date = new Date(),
): Promise<EffectivePolicy[]> {
  const rules = await loadRules({ id: subjectId }, null, now);
  if (!rules) return [];

  const keys = [
    ...new Set([
      ...rules.tenantRows.map(row => row.resourceKey),
      ...rules.subjectRows.map(row => row.resourceKey),
    ]),
  ].sort();

  return keys.map(resourceKey => {
    const candidates = candidateKeys(resourceKey);
    // The rows that *apply* to this key, which for a tool may be the app
    // wildcard — the portal needs to explain the effective answer, not just
    // repeat the literal row.
    const tenantRow = pickMostSpecific(rules.tenantRows, candidates);
    const subjectRow = pickMostSpecific(rules.subjectRows, candidates);
    const decision = decide({ resourceKey, ...pickRows(rules) });
    return {
      resourceKey,
      gated: decision.gated,
      reason: decision.reason,
      locked: tenantRow?.locked ?? false,
      customerSetting: subjectRow ? subjectRow.enabled : null,
      tenantDefault: tenantRow ? tenantRow.enabled : null,
    };
  });
}

/** The live grant covering this tool, exact before wildcard, or null. */
export async function activeGrant(
  subjectId: string,
  resourceKey: string,
  now: Date = new Date(),
): Promise<Grant | null> {
  const keys = candidateKeys(resourceKey);
  const rows = await prisma.grant.findMany({
    where: { subjectId, resourceKey: { in: keys }, expiresAt: { gt: now } },
    orderBy: { expiresAt: 'desc' },
  });
  return pickMostSpecific(rows, keys) ?? null;
}

/**
 * "Allow this tool without asking for a while", created when a phone approves
 * with scope `window`. The window is the server's, not the caller's, so an
 * integrator cannot widen it.
 */
export async function createGrant(
  subjectId: string,
  resourceKey: string,
  now: Date = new Date(),
): Promise<Grant> {
  return prisma.grant.create({
    data: {
      id: randomId('grn'),
      subjectId,
      resourceKey,
      expiresAt: new Date(now.getTime() + config.grantWindowSec * 1000),
    },
  });
}

/**
 * The agency rule that applies to this key when it is locked *on* — the one
 * case where a customer is refused a change. An unlocked exact row shadows a
 * locked wildcard, matching `decide`.
 */
export async function lockedOnRule(
  tenantId: string,
  resourceKey: string,
): Promise<RuleRow | null> {
  const keys = candidateKeys(resourceKey);
  const rows = await prisma.policy.findMany({
    where: { tenantId, subjectId: null, resourceKey: { in: keys } },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  const applies = pickMostSpecific(rows, keys);
  return applies && applies.locked && applies.enabled ? applies : null;
}
