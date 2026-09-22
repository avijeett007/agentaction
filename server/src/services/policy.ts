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

/** The windows a phone may choose between, shortest first. */
export const GRANT_WINDOWS_SEC: readonly number[] = config.grantWindowChoicesSec;

/** Is this a window we offer at all? Anything else is refused, never rounded. */
export function isGrantWindow(windowSec: number): boolean {
  return GRANT_WINDOWS_SEC.includes(windowSec);
}

export interface GrantWindow {
  /** Seconds that will actually be granted. 0 means no grant at all. */
  windowSec: number;
  /** True when the tenant ceiling shortened what the phone asked for. */
  clamped: boolean;
  /** The ceiling that applied, so the answer can say why. */
  maxWindowSec: number;
}

/**
 * What a tenant will actually allow, given what the phone asked for.
 *
 * The ceiling belongs to the agency, not to the phone and not to the
 * integrator: an agency running a bank can cap every one of its customers at
 * five minutes, and a customer who taps "8 hours" gets five. The caller is
 * told, rather than silently handed a shorter window than the screen promised.
 * A ceiling of 0 turns windows off entirely — the approval still stands, it
 * just covers the one call.
 */
export function clampGrantWindow(requestedSec: number, tenantMaxSec: number): GrantWindow {
  const ceiling = Math.max(0, Math.floor(tenantMaxSec));
  const requested = Math.max(0, Math.floor(requestedSec));
  const windowSec = Math.min(requested, ceiling);
  return { windowSec, clamped: windowSec < requested, maxWindowSec: ceiling };
}

/**
 * "Allow this tool without asking for a while", created when a phone approves
 * with scope `window`. The length is the one the phone signed for, already
 * clamped by `clampGrantWindow` — an integrator never gets to widen it, and a
 * caller that names nothing gets the server's default.
 */
export async function createGrant(
  subjectId: string,
  resourceKey: string,
  windowSec: number = config.grantWindowSec,
  now: Date = new Date(),
): Promise<Grant> {
  return prisma.grant.create({
    data: {
      id: randomId('grn'),
      subjectId,
      resourceKey,
      expiresAt: new Date(now.getTime() + windowSec * 1000),
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

/* ---------------------------------------------------------------------------
 * Where "intelligent decisioning" would go
 *
 * The enterprise ask is to cut approval fatigue by answering the obvious cases
 * without ringing a phone — the fourteenth identical appointment reminder of
 * the morning, to a number the customer has mailed a hundred times before.
 *
 * The seam is `decide()` above, and only there. It is already the single
 * chokepoint every gated call passes through, it is pure, and it returns a
 * `reason` the portal and the audit trail already render. A model-backed mode
 * would slot in as one more precedence step, between the grant check and the
 * locked-rule check, returning `{ gated: false, reason: 'auto' }` — never
 * `gated: true`, because a machine that can *invent* approval requests is a
 * machine that can train people to tap through them. It may only ever answer
 * the question "is this so plainly routine that we need not ask?"; a "no" from
 * it has to mean "ask the human", not "refuse".
 *
 * What it would need, none of which exists yet:
 *
 *  - History. We store `AuditEvent` rows and one `Decision` per request, but
 *    nothing queryable per `(subject, resourceKey, argument shape)`. Deciding
 *    "they always say yes to this" needs the shape, and today the server holds
 *    only `argsHash` — deliberately, so it cannot read the arguments. Either
 *    the integrator starts sending structured, non-sensitive features, or this
 *    can only ever reason about the hash, which means exact repeats and
 *    nothing more. That choice is a privacy decision, not a modelling one.
 *  - A tenant switch and a tier gate, with a default of off, in the same shape
 *    as `Policy.locked` — an agency must be able to forbid it outright for a
 *    customer, and a customer must be able to turn it off for themselves.
 *  - A ceiling on what it may wave through: per-window counts, a value or
 *    risk cap from the integrator, and never a resource key the agency has
 *    locked on. `clampGrantWindow` is the pattern to copy.
 *  - An audit story that is honest about it: `request.autodecided` rows, the
 *    inputs that led there, and a visible list in the app the owner can scroll
 *    — "here is what we did not ask you about". Without that, this feature is
 *    indistinguishable from the approval step quietly not running.
 *  - An answer to the obvious attack: an agent that discovers the auto-allowed
 *    shape and drives everything through it. Whatever ships, the phone must
 *    still see a sample, and a human must still be able to say "stop deciding
 *    for me" in one tap.
 *
 * Nothing here is built. It is written down so the next person adds it at the
 * chokepoint rather than sprinkling exceptions through the routes.
 * ------------------------------------------------------------------------- */
