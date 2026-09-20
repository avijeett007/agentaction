import { prisma } from '../../src/prisma';
import { randomId } from '../../src/lib/crypto';
import { config } from '../../src/config';
import {
  activeGrant,
  candidateKeys,
  createGrant,
  evaluateForExternalId,
  listEffectivePolicies,
  lockedOnRule,
  resolvePolicy,
  wildcardKeyFor,
} from '../../src/services/policy';
import { resetDb } from '../helpers/db';
import { createSubject, createTenant } from '../helpers/factories';

/**
 * The precedence rules, driven through real rows: the service is the one place
 * that decides whether a tool call waits for a human, so these tests write
 * policies and grants exactly as the routes do.
 */

const SEND = 'gmail/GMAIL_SEND_EMAIL';
const DRAFT = 'gmail/GMAIL_CREATE_DRAFT';
const ANY_GMAIL = 'gmail/*';

let tenantId: string;
let subjectId: string;
let externalId: string;

beforeEach(async () => {
  await resetDb();
  const { tenant } = await createTenant();
  tenantId = tenant.id;
  const subject = await createSubject(tenant.id, 'cust_policy');
  subjectId = subject.id;
  externalId = subject.externalId;
});

afterAll(async () => {
  await prisma.$disconnect();
});

function agencyRule(resourceKey: string, enabled: boolean, locked = false, tenant = tenantId) {
  return prisma.policy.create({
    data: { id: randomId('pol'), tenantId: tenant, subjectId: null, resourceKey, enabled, locked },
  });
}

function customerRule(resourceKey: string, enabled: boolean, subject = subjectId) {
  return prisma.policy.create({
    data: { id: randomId('pol'), tenantId, subjectId: subject, resourceKey, enabled },
  });
}

function grantUntil(resourceKey: string, expiresAt: Date, subject = subjectId) {
  return prisma.grant.create({
    data: { id: randomId('grn'), subjectId: subject, resourceKey, expiresAt },
  });
}

const inTenMinutes = () => new Date(Date.now() + 10 * 60 * 1000);
const tenMinutesAgo = () => new Date(Date.now() - 10 * 60 * 1000);

describe('key matching', () => {
  it('reduces a tool key to its app wildcard, and leaves a wildcard alone', () => {
    expect(wildcardKeyFor(SEND)).toBe(ANY_GMAIL);
    expect(wildcardKeyFor(ANY_GMAIL)).toBe(ANY_GMAIL);
  });

  it('offers the exact key before the wildcard, and never twice', () => {
    expect(candidateKeys(SEND)).toEqual([SEND, ANY_GMAIL]);
    expect(candidateKeys(ANY_GMAIL)).toEqual([ANY_GMAIL]);
  });
});

describe('resolvePolicy precedence', () => {
  it('gates nothing when no one has said anything', async () => {
    expect(await resolvePolicy(subjectId, SEND)).toEqual({ gated: false, reason: 'off' });
  });

  it('applies the agency default when the customer is silent', async () => {
    await agencyRule(SEND, true);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: true,
      reason: 'default',
      matchedKey: SEND,
    });
  });

  it("lets the customer's own 'off' beat an agency default that is on but unlocked", async () => {
    await agencyRule(SEND, true, false);
    await customerRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'customer',
      matchedKey: SEND,
    });
  });

  it("lets the customer switch a rule on that the agency leaves off", async () => {
    await agencyRule(SEND, false);
    await customerRule(SEND, true);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: true,
      reason: 'customer',
      matchedKey: SEND,
    });
  });

  it('keeps a locked agency rule on however the customer answers', async () => {
    await agencyRule(SEND, true, true);
    await customerRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: SEND,
    });
  });

  it('honours a locked agency rule that is locked off', async () => {
    // The agency has decided this tool never asks; the customer cannot add a gate.
    await agencyRule(SEND, false, true);
    await customerRule(SEND, true);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'locked',
      matchedKey: SEND,
    });
  });
});

describe('exact keys beat wildcards', () => {
  it('prefers the agency exact row over the agency wildcard', async () => {
    await agencyRule(ANY_GMAIL, true);
    await agencyRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'default',
      matchedKey: SEND,
    });
    // The wildcard still answers for every other tool in the app.
    expect(await resolvePolicy(subjectId, DRAFT)).toEqual({
      gated: true,
      reason: 'default',
      matchedKey: ANY_GMAIL,
    });
  });

  it("prefers the customer's exact row over their own wildcard", async () => {
    await customerRule(ANY_GMAIL, true);
    await customerRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'customer',
      matchedKey: SEND,
    });
    expect(await resolvePolicy(subjectId, DRAFT)).toEqual({
      gated: true,
      reason: 'customer',
      matchedKey: ANY_GMAIL,
    });
  });

  it("lets a locked agency wildcard beat the customer's exact row", async () => {
    await agencyRule(ANY_GMAIL, true, true);
    await customerRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: ANY_GMAIL,
    });
  });

  it('treats an unlocked agency exact row as a carve-out from its own locked wildcard', async () => {
    // The agency locked the app but wrote a deliberate, unlocked row for one
    // tool, so that tool is the customer's to decide.
    await agencyRule(ANY_GMAIL, true, true);
    await agencyRule(SEND, true, false);
    await customerRule(SEND, false);
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'customer',
      matchedKey: SEND,
    });
    expect(await resolvePolicy(subjectId, DRAFT)).toEqual({
      gated: true,
      reason: 'locked',
      matchedKey: ANY_GMAIL,
    });
  });
});

describe('grants', () => {
  it('beats even a locked agency rule while it lasts', async () => {
    await agencyRule(SEND, true, true);
    await grantUntil(SEND, inTenMinutes());
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: false,
      reason: 'grant',
      matchedKey: SEND,
    });
  });

  it('stops counting once it has expired', async () => {
    await agencyRule(SEND, true);
    await grantUntil(SEND, tenMinutesAgo());
    expect(await resolvePolicy(subjectId, SEND)).toEqual({
      gated: true,
      reason: 'default',
      matchedKey: SEND,
    });
  });

  it('does not spill onto another tool', async () => {
    await agencyRule(ANY_GMAIL, true);
    await grantUntil(SEND, inTenMinutes());
    expect(await resolvePolicy(subjectId, DRAFT)).toEqual({
      gated: true,
      reason: 'default',
      matchedKey: ANY_GMAIL,
    });
  });

  it('covers every tool of the app when the grant itself is a wildcard', async () => {
    await agencyRule(ANY_GMAIL, true);
    await grantUntil(ANY_GMAIL, inTenMinutes());
    expect(await resolvePolicy(subjectId, DRAFT)).toEqual({
      gated: false,
      reason: 'grant',
      matchedKey: ANY_GMAIL,
    });
  });

  it('belongs to one subject only', async () => {
    const other = await createSubject(tenantId, 'cust_other');
    await agencyRule(SEND, true);
    await grantUntil(SEND, inTenMinutes(), other.id);
    expect(await resolvePolicy(subjectId, SEND)).toMatchObject({ gated: true, reason: 'default' });
  });

  it('honours the clock passed in rather than the wall clock', async () => {
    await agencyRule(SEND, true);
    const expiresAt = new Date(Date.now() + 60 * 1000);
    await grantUntil(SEND, expiresAt);
    const afterExpiry = new Date(expiresAt.getTime() + 1000);
    expect(await resolvePolicy(subjectId, SEND, afterExpiry)).toMatchObject({ reason: 'default' });
  });
});

describe('activeGrant', () => {
  it('returns the live grant, exact before wildcard', async () => {
    await grantUntil(ANY_GMAIL, inTenMinutes());
    await grantUntil(SEND, inTenMinutes());
    const found = await activeGrant(subjectId, SEND);
    expect(found?.resourceKey).toBe(SEND);
  });

  it('returns a wildcard grant for a tool it covers', async () => {
    await grantUntil(ANY_GMAIL, inTenMinutes());
    expect((await activeGrant(subjectId, DRAFT))?.resourceKey).toBe(ANY_GMAIL);
  });

  it('returns null for an expired grant and for another tool', async () => {
    await grantUntil(SEND, tenMinutesAgo());
    await grantUntil('slack/SLACK_POST', inTenMinutes());
    expect(await activeGrant(subjectId, SEND)).toBeNull();
    expect(await activeGrant(subjectId, DRAFT)).toBeNull();
  });
});

describe('createGrant', () => {
  it('opens the server-configured window, not one the caller chose', async () => {
    const now = new Date('2026-09-20T10:00:00.000Z');
    const grant = await createGrant(subjectId, SEND, now);
    expect(grant.expiresAt.getTime() - now.getTime()).toBe(config.grantWindowSec * 1000);
    expect(config.grantWindowSec).toBe(900); // fifteen minutes by default
    expect(await activeGrant(subjectId, SEND, now)).not.toBeNull();
  });
});

describe('tenant isolation', () => {
  it('never reads another agency rules or evaluates another agency customer', async () => {
    const other = await createTenant();
    await agencyRule(SEND, true, true, other.tenant.id);

    expect(await resolvePolicy(subjectId, SEND)).toEqual({ gated: false, reason: 'off' });
    expect(
      await evaluateForExternalId({ tenantId: other.tenant.id, externalId, resourceKey: SEND }),
    ).toEqual({ gated: false, reason: 'off' });
  });

  it('gates nothing for a subject that does not exist', async () => {
    expect(await resolvePolicy('sub_nobody', SEND)).toEqual({ gated: false, reason: 'off' });
    expect(
      await evaluateForExternalId({ tenantId, externalId: 'never_paired', resourceKey: SEND }),
    ).toEqual({ gated: false, reason: 'off' });
    expect(await prisma.subject.count()).toBe(1);
  });
});

describe('listEffectivePolicies', () => {
  it('lists every key either level mentions, with the answer and where it came from', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    await agencyRule('slack/SLACK_POST', true, false);
    await customerRule('slack/SLACK_POST', false);
    await customerRule('stripe/STRIPE_REFUND', true);

    const list = await listEffectivePolicies(subjectId);
    expect(list.map(row => row.resourceKey)).toEqual([
      ANY_GMAIL,
      'slack/SLACK_POST',
      'stripe/STRIPE_REFUND',
    ]);

    expect(list[0]).toEqual({
      resourceKey: ANY_GMAIL,
      gated: true,
      reason: 'locked',
      locked: true,
      customerSetting: null,
      tenantDefault: true,
    });
    expect(list[1]).toEqual({
      resourceKey: 'slack/SLACK_POST',
      gated: false,
      reason: 'customer',
      locked: false,
      customerSetting: false,
      tenantDefault: true,
    });
    expect(list[2]).toEqual({
      resourceKey: 'stripe/STRIPE_REFUND',
      gated: true,
      reason: 'customer',
      locked: false,
      customerSetting: true,
      tenantDefault: null,
    });
  });

  it('shows the wildcard that actually applies to a tool key', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    await customerRule(SEND, false);

    const byKey = Object.fromEntries(
      (await listEffectivePolicies(subjectId)).map(row => [row.resourceKey, row]),
    );
    expect(byKey[SEND]).toEqual({
      resourceKey: SEND,
      gated: true,
      reason: 'locked',
      locked: true,
      customerSetting: false,
      tenantDefault: true,
    });
  });

  it('is empty for an unknown subject', async () => {
    expect(await listEffectivePolicies('sub_nobody')).toEqual([]);
  });
});

describe('lockedOnRule', () => {
  it('finds the agency rule that holds a tool on, exact or wildcard', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    expect((await lockedOnRule(tenantId, SEND))?.resourceKey).toBe(ANY_GMAIL);
  });

  it('ignores a lock that holds a tool off, and an unlocked default', async () => {
    await agencyRule(SEND, false, true);
    await agencyRule('slack/SLACK_POST', true, false);
    expect(await lockedOnRule(tenantId, SEND)).toBeNull();
    expect(await lockedOnRule(tenantId, 'slack/SLACK_POST')).toBeNull();
  });

  it('lets an unlocked exact row shadow a locked wildcard', async () => {
    await agencyRule(ANY_GMAIL, true, true);
    await agencyRule(SEND, true, false);
    expect(await lockedOnRule(tenantId, SEND)).toBeNull();
    expect((await lockedOnRule(tenantId, DRAFT))?.resourceKey).toBe(ANY_GMAIL);
  });
});
