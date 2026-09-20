import type { RequestHandler } from 'express';
import type { Tenant } from '@prisma/client';
import { prisma } from '../prisma';
import { sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';

declare module 'express-serve-static-core' {
  interface Request {
    tenant?: Tenant;
    rawBody?: string;
  }
}

/**
 * Authenticates an integrator — the gateway or application embedding this — by API key.
 * Keys are stored as a sha256 hash, so a database leak does not hand over
 * working credentials.
 */
export const integratorAuth: RequestHandler = async (req, _res, next) => {
  try {
    const header = req.header('authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!key) throw ApiError.unauthorized('Missing API key');

    const tenant = await prisma.tenant.findUnique({ where: { apiKeyHash: sha256Hex(key) } });
    if (!tenant) throw ApiError.unauthorized('Invalid API key');
    if (tenant.disabled) throw ApiError.forbidden('This tenant is disabled', 'tenant_disabled');

    req.tenant = tenant;
    next();
  } catch (err) {
    next(err);
  }
};
