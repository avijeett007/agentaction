import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { config } from '../config';
import { randomId, randomSecret, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { integratorAuth } from '../middleware/integratorAuth';
import { recordAudit } from '../services/audit';
import { toApiError } from './tenants';

export const pairingsRouter = Router();

const createPairingSchema = z.object({
  externalId: z.string().min(1).max(200),
  label: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
});

/**
 * POST /v1/pairings — mint the payload the portal renders as a QR code.
 *
 * The subject is upserted on the way through so "Add a phone" is a single call
 * for the integrator, whether or not it has told us about this customer before.
 */
pairingsRouter.post('/', integratorAuth, async (req, res, next) => {
  try {
    const body = createPairingSchema.parse(req.body);
    const tenant = req.tenant!;

    const subject = await prisma.subject.upsert({
      where: { tenantId_externalId: { tenantId: tenant.id, externalId: body.externalId } },
      create: {
        id: randomId('sub'),
        tenantId: tenant.id,
        externalId: body.externalId,
        label: body.label,
        email: body.email ?? null,
      },
      update: { label: body.label, email: body.email ?? null },
    });

    // Only the hash is stored: a leaked database cannot be used to pair a phone,
    // and this response is the one and only place the plain secret exists.
    const secret = randomSecret();
    const pairing = await prisma.pairingCode.create({
      data: {
        id: randomId('pair'),
        subjectId: subject.id,
        secretHash: sha256Hex(secret),
        expiresAt: new Date(Date.now() + config.pairingTtlSec * 1000),
      },
    });

    await recordAudit({
      tenantId: tenant.id,
      subjectId: subject.id,
      type: 'pairing.created',
      data: { pairingId: pairing.id, expiresAt: pairing.expiresAt.toISOString() },
    });

    res.status(201).json({
      pairing: { id: pairing.id, expiresAt: pairing.expiresAt },
      qrPayload: {
        v: 1,
        serverUrl: config.publicBaseUrl,
        secret,
        tenantId: tenant.id,
        brand: {
          name: tenant.brandName,
          logoUrl: tenant.brandLogoUrl,
          color: tenant.brandColor,
        },
        subject: { label: subject.label },
      },
    });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * GET /v1/pairings/:id — what the portal polls while the QR code is on screen,
 * so the page can move on the moment the phone has used the code.
 */
pairingsRouter.get('/:id', integratorAuth, async (req, res, next) => {
  try {
    // Scoped through the subject: one tenant may not watch another's pairing.
    const pairing = await prisma.pairingCode.findFirst({
      where: { id: req.params.id, subject: { tenantId: req.tenant!.id } },
    });
    if (!pairing) throw ApiError.notFound('No such pairing');

    res.json({
      pairing: {
        id: pairing.id,
        status: pairingStatus(pairing),
        expiresAt: pairing.expiresAt,
        usedAt: pairing.usedAt,
      },
    });
  } catch (err) {
    next(toApiError(err));
  }
});

/** Expiry is never written to the row — a lapsed code is just an old one. */
function pairingStatus(pairing: { usedAt: Date | null; expiresAt: Date }): 'pending' | 'used' | 'expired' {
  if (pairing.usedAt) return 'used';
  return pairing.expiresAt.getTime() <= Date.now() ? 'expired' : 'pending';
}
