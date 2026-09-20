import { Router } from 'express';
import { z } from 'zod';
import type { Policy, Subject, Tenant } from '@prisma/client';
import { prisma } from '../prisma';
import { randomId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { integratorAuth } from '../middleware/integratorAuth';
import { recordAudit } from '../services/audit';
import { evaluateForExternalId, listEffectivePolicies, lockedOnRule } from '../services/policy';
import { toApiError } from './tenants';

/**
 * Which tools need approval, read and written by the integrator on behalf of
 * either side: the agency sets defaults and locks, the customer sets their own
 * rules, and the MCP gateway asks `/evaluate` before every tool call.
 */
export const policiesRouter = Router();

// Every route here belongs to an integrator API key; nothing on this router is
// reachable by a phone or by the public.
policiesRouter.use(integratorAuth);

/**
 * `<app>/<tool>` or `<app>/*`.
 *
 * Canonicalised here — lowercase app, uppercase tool — rather than trusted from
 * the caller. Rules are written by one integrator surface (the portal) and read
 * by another (the gateway), and if the two spell the key differently the rule
 * saves, shows as on, and gates nothing: a security control that only appears
 * to be there. Folding on the way in means no client can reintroduce that split,
 * and it applies equally to writes and to /evaluate, so both sides of the
 * comparison are folded the same way.
 */
const resourceKeySchema = z
  .string()
  .max(200)
  .regex(
    /^[a-z0-9][a-z0-9_.-]*\/(\*|[A-Za-z0-9_.:-]+)$/i,
    'resourceKey must look like "gmail/GMAIL_SEND_EMAIL" or "gmail/*"',
  )
  .transform(key => {
    const slash = key.indexOf('/');
    const app = key.slice(0, slash).toLowerCase();
    const tool = key.slice(slash + 1);
    return `${app}/${tool === '*' ? '*' : tool.toUpperCase()}`;
  });

const externalIdSchema = z.string().min(1).max(200);

const listQuerySchema = z.object({ externalId: externalIdSchema });

const subjectRuleSchema = z.object({
  externalId: externalIdSchema,
  resourceKey: resourceKeySchema,
  enabled: z.boolean(),
});

const tenantRuleSchema = z.object({
  resourceKey: resourceKeySchema,
  enabled: z.boolean(),
  // Omitted means "a default the customer may change", which is the safer
  // reading of a missing field than "locked".
  locked: z.boolean().optional().default(false),
});

const clearSubjectRuleSchema = z.object({
  externalId: externalIdSchema,
  resourceKey: resourceKeySchema,
});

const evaluateSchema = z.object({
  externalId: externalIdSchema,
  resourceKey: resourceKeySchema,
});

/** GET /v1/policies?externalId=… — the rules as this customer experiences them. */
policiesRouter.get('/', async (req, res, next) => {
  try {
    const { externalId } = listQuerySchema.parse(req.query);
    const subject = await requireSubject(req.tenant!.id, externalId);
    res.json({ policies: await listEffectivePolicies(subject.id) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** PUT /v1/policies/subject — the customer's own answer for one tool. */
policiesRouter.put('/subject', async (req, res, next) => {
  try {
    const body = subjectRuleSchema.parse(req.body);
    const tenantId = req.tenant!.id;
    const subject = await requireSubject(tenantId, body.externalId);

    // Turning a rule *on* is always allowed; only switching it off can collide
    // with an agency lock.
    if (!body.enabled) await refuseIfLocked(req.tenant!, body.resourceKey);

    const policy = await prisma.policy.upsert({
      where: {
        tenantId_subjectId_resourceKey: {
          tenantId,
          subjectId: subject.id,
          resourceKey: body.resourceKey,
        },
      },
      create: {
        id: randomId('pol'),
        tenantId,
        subjectId: subject.id,
        resourceKey: body.resourceKey,
        enabled: body.enabled,
      },
      update: { enabled: body.enabled },
    });

    await recordAudit({
      tenantId,
      subjectId: subject.id,
      type: 'policy.subject.updated',
      data: { resourceKey: body.resourceKey, enabled: body.enabled },
    });

    res.json({ policy: publicPolicy(policy) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** PUT /v1/policies/tenant — the agency default, optionally locked. */
/**
 * GET /v1/policies/tenant — the agency's own rows: its defaults and its locks.
 *
 * Separate from `GET /` because that one answers "what applies to this
 * customer", which needs a subject. The agency's dashboard has no subject: it
 * is editing the rules that apply to all of them.
 */
policiesRouter.get('/tenant', async (req, res, next) => {
  try {
    const policies = await prisma.policy.findMany({
      where: { tenantId: req.tenant!.id, subjectId: null },
      orderBy: { resourceKey: 'asc' },
    });
    res.json({ policies: policies.map(publicPolicy) });
  } catch (err) {
    next(toApiError(err));
  }
});

policiesRouter.put('/tenant', async (req, res, next) => {
  try {
    const body = tenantRuleSchema.parse(req.body);
    const tenantId = req.tenant!.id;

    // Not an upsert: the compound unique cannot be expressed with a null
    // subjectId (and SQL treats those nulls as distinct anyway), so the agency
    // row is found by hand and written by id.
    const existing = await prisma.policy.findFirst({
      where: { tenantId, subjectId: null, resourceKey: body.resourceKey },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    const policy = existing
      ? await prisma.policy.update({
          where: { id: existing.id },
          data: { enabled: body.enabled, locked: body.locked },
        })
      : await prisma.policy.create({
          data: {
            id: randomId('pol'),
            tenantId,
            subjectId: null,
            resourceKey: body.resourceKey,
            enabled: body.enabled,
            locked: body.locked,
          },
        });

    await recordAudit({
      tenantId,
      type: 'policy.tenant.updated',
      data: { resourceKey: body.resourceKey, enabled: body.enabled, locked: body.locked },
    });

    res.json({ policy: publicPolicy(policy) });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * DELETE /v1/policies/subject — forget the customer's answer so the agency
 * default applies again. Refused under a lock for the same reason the update
 * is: while the agency holds a rule on, the customer's answer is not theirs
 * to change.
 */
policiesRouter.delete('/subject', async (req, res, next) => {
  try {
    const body = clearSubjectRuleSchema.parse(req.body);
    const tenantId = req.tenant!.id;
    const subject = await requireSubject(tenantId, body.externalId);
    await refuseIfLocked(req.tenant!, body.resourceKey);

    const { count } = await prisma.policy.deleteMany({
      where: { tenantId, subjectId: subject.id, resourceKey: body.resourceKey },
    });

    await recordAudit({
      tenantId,
      subjectId: subject.id,
      type: 'policy.subject.cleared',
      data: { resourceKey: body.resourceKey, removed: count > 0 },
    });

    res.json({ removed: count > 0 });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * POST /v1/policies/evaluate — the question the MCP gateway asks before every
 * tool call, so it is one HTTP call and one database round trip. A subject we
 * have never heard of is not gated: approval is opt-in, and a customer who has
 * never paired must not find their agent blocked. Nothing is created here.
 */
policiesRouter.post('/evaluate', async (req, res, next) => {
  try {
    const body = evaluateSchema.parse(req.body);
    const decision = await evaluateForExternalId({
      tenantId: req.tenant!.id,
      externalId: body.externalId,
      resourceKey: body.resourceKey,
    });
    res.json(decision);
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * The subject, looked up inside this tenant only — an id belonging to another
 * agency simply does not exist here, so cross-tenant reads answer 404 rather
 * than confirming the account.
 */
async function requireSubject(tenantId: string, externalId: string): Promise<Subject> {
  const subject = await prisma.subject.findUnique({
    where: { tenantId_externalId: { tenantId, externalId } },
  });
  if (!subject) throw ApiError.notFound('No such subject');
  return subject;
}

/** 409 when the agency holds this rule on and the customer is trying to escape it. */
async function refuseIfLocked(tenant: Tenant, resourceKey: string): Promise<void> {
  const locked = await lockedOnRule(tenant.id, resourceKey);
  if (!locked) return;
  throw ApiError.conflict(
    'policy_locked',
    `${tenant.brandName} requires approval for ${locked.resourceKey} and has locked this rule on.`,
  );
}

function publicPolicy(policy: Policy) {
  return {
    resourceKey: policy.resourceKey,
    enabled: policy.enabled,
    locked: policy.locked,
    scope: policy.subjectId ? 'subject' : 'tenant',
  };
}
