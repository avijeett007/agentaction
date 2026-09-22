import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { config } from '../config';
import { generateApiKey, randomId, randomSecret, sha256Hex, timingSafeEqual } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { integratorAuth } from '../middleware/integratorAuth';
import { recordAudit } from '../services/audit';

export const tenantsRouter = Router();

const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  brandName: z.string().min(1).max(100),
  brandLogoUrl: z.string().url().max(2000).optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'brandColor must be a #rrggbb colour')
    .optional(),
  webhookUrl: z.string().url().max(2000).optional(),
  deviceCap: z.number().int().min(1).max(5).optional(),
  requestTtlSec: z.number().int().min(300).max(3600).optional(),
  /**
   * The longest "approve for a while" window this agency will accept. Any
   * whole number of seconds up to the operator's own ceiling: a bank can cap
   * its customers at 300, and 0 switches windows off altogether so every
   * approval covers exactly one call.
   */
  maxGrantWindowSec: z.number().int().min(0).max(config.maxGrantWindowSec).optional(),
});

/** What a tenant created without a colour gets, and what `brandColor: null` restores. */
const DEFAULT_BRAND_COLOR = '#3B82F6';

/**
 * A field left out is left alone. `null` clears the logo and puts the default
 * colour back, so an agency that removes its branding can say so; without it
 * the phone would keep showing the old logo for good.
 */
const updateTenantSchema = createTenantSchema
  .partial()
  .omit({ name: true })
  .extend({
    brandLogoUrl: z.string().url().max(2000).nullable().optional(),
    brandColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'brandColor must be a #rrggbb colour')
      .nullable()
      .optional(),
  });

const subjectSchema = z.object({
  externalId: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
});

/** Provisioning a tenant is an operator action, guarded by a root key. */
function requireAdminKey(header: string | undefined) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw ApiError.forbidden('Tenant provisioning is disabled', 'admin_key_unset');
  const provided = header?.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!provided || !timingSafeEqual(sha256Hex(provided), sha256Hex(adminKey))) {
    throw ApiError.unauthorized('Invalid admin key');
  }
}

/** POST /v1/tenants — create a brand. Returns the API key once and never again. */
tenantsRouter.post('/', async (req, res, next) => {
  try {
    requireAdminKey(req.header('authorization'));
    const body = createTenantSchema.parse(req.body);
    const { key, hash } = generateApiKey();

    const tenant = await prisma.tenant.create({
      data: {
        id: randomId('ten'),
        name: body.name,
        brandName: body.brandName,
        brandLogoUrl: body.brandLogoUrl ?? null,
        brandColor: body.brandColor ?? DEFAULT_BRAND_COLOR,
        webhookUrl: body.webhookUrl ?? null,
        webhookSecret: randomSecret(),
        apiKeyHash: hash,
        deviceCap: body.deviceCap ?? config.maxDeviceCap,
        requestTtlSec: body.requestTtlSec ?? 600,
        maxGrantWindowSec: body.maxGrantWindowSec ?? config.defaultMaxGrantWindowSec,
      },
    });

    await recordAudit({ tenantId: tenant.id, type: 'tenant.created', data: { name: tenant.name } });

    res.status(201).json({
      tenant: publicTenant(tenant),
      apiKey: key,
      webhookSecret: tenant.webhookSecret,
    });
  } catch (err) {
    next(toApiError(err));
  }
});

/** GET /v1/tenants/me — what this API key belongs to. */
tenantsRouter.get('/me', integratorAuth, (req, res) => {
  res.json({ tenant: publicTenant(req.tenant!) });
});

/** PATCH /v1/tenants/me — branding, webhook target, caps. */
tenantsRouter.patch('/me', integratorAuth, async (req, res, next) => {
  try {
    const body = updateTenantSchema.parse(req.body);
    const tenant = await prisma.tenant.update({
      where: { id: req.tenant!.id },
      data: {
        brandName: body.brandName,
        brandLogoUrl: body.brandLogoUrl,
        brandColor: body.brandColor === null ? DEFAULT_BRAND_COLOR : body.brandColor,
        webhookUrl: body.webhookUrl,
        deviceCap: body.deviceCap,
        requestTtlSec: body.requestTtlSec,
        maxGrantWindowSec: body.maxGrantWindowSec,
      },
    });
    await recordAudit({ tenantId: tenant.id, type: 'tenant.updated', data: { ...body } });
    res.json({ tenant: publicTenant(tenant) });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * PUT /v1/tenants/me/subjects — create or update one end-user account.
 * Idempotent on externalId so the integrator can call it on every pairing.
 */
tenantsRouter.put('/me/subjects', integratorAuth, async (req, res, next) => {
  try {
    const body = subjectSchema.parse(req.body);
    const tenantId = req.tenant!.id;
    const subject = await prisma.subject.upsert({
      where: { tenantId_externalId: { tenantId, externalId: body.externalId } },
      create: {
        id: randomId('sub'),
        tenantId,
        externalId: body.externalId,
        label: body.label,
        email: body.email ?? null,
      },
      update: { label: body.label, email: body.email ?? null },
    });
    res.json({ subject: publicSubject(subject) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** GET /v1/tenants/me/subjects/:externalId */
tenantsRouter.get('/me/subjects/:externalId', integratorAuth, async (req, res, next) => {
  try {
    const subject = await prisma.subject.findUnique({
      where: {
        tenantId_externalId: { tenantId: req.tenant!.id, externalId: req.params.externalId },
      },
      include: { devices: { where: { revokedAt: null } } },
    });
    if (!subject) throw ApiError.notFound('No such subject');
    res.json({
      subject: publicSubject(subject),
      deviceCount: subject.devices.length,
    });
  } catch (err) {
    next(toApiError(err));
  }
});

function publicTenant(tenant: {
  id: string;
  name: string;
  brandName: string;
  brandLogoUrl: string | null;
  brandColor: string;
  webhookUrl: string | null;
  deviceCap: number;
  requestTtlSec: number;
  maxGrantWindowSec: number;
}) {
  return {
    id: tenant.id,
    name: tenant.name,
    brandName: tenant.brandName,
    brandLogoUrl: tenant.brandLogoUrl,
    brandColor: tenant.brandColor,
    webhookUrl: tenant.webhookUrl,
    deviceCap: tenant.deviceCap,
    requestTtlSec: tenant.requestTtlSec,
    maxGrantWindowSec: tenant.maxGrantWindowSec,
  };
}

function publicSubject(subject: {
  id: string;
  externalId: string;
  label: string;
  email: string | null;
}) {
  return {
    id: subject.id,
    externalId: subject.externalId,
    label: subject.label,
    email: subject.email,
  };
}

/** Turns a Zod failure into a 400 the caller can act on. */
export function toApiError(err: unknown): unknown {
  if (err instanceof z.ZodError) {
    return ApiError.badRequest('invalid_request', 'Invalid request body', err.issues);
  }
  return err;
}
