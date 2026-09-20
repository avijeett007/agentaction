import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { fromBase64url, randomId, sha256Hex } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { integratorAuth } from '../middleware/integratorAuth';
import { deviceAuth } from '../middleware/deviceAuth';
import { sendDeviceAddedPush } from '../services/push';
import { recordAudit } from '../services/audit';
import { toApiError } from './tenants';

export const devicesRouter = Router();

const registerSchema = z.object({
  secret: z.string().min(1).max(500),
  devicePubKey: z.string().min(1).max(200),
  approvalPubKey: z.string().min(1).max(200),
  label: z.string().min(1).max(100),
  platform: z.enum(['ios', 'android']),
  model: z.string().max(100).optional(),
  pushToken: z.string().max(500).optional(),
});

const updateDeviceSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  // Null is meaningful: the app clears the token when the user turns
  // notifications off, which is not the same as "leave it alone".
  pushToken: z.string().max(500).nullable().optional(),
});

const listQuerySchema = z.object({
  externalId: z.string().min(1).max(200),
});

/**
 * POST /v1/devices/register — the phone redeems the pairing secret.
 *
 * Deliberately unauthenticated: the secret from the QR code *is* the
 * credential, and the app has no other identity until this call succeeds.
 */
devicesRouter.post('/register', async (req, res, next) => {
  try {
    const body = registerSchema.parse(req.body);
    const devicePubKey = requireEd25519Key(body.devicePubKey, 'devicePubKey');
    const approvalPubKey = requireEd25519Key(body.approvalPubKey, 'approvalPubKey');

    const pairing = await prisma.pairingCode.findUnique({
      where: { secretHash: sha256Hex(body.secret) },
      include: { subject: { include: { tenant: true } } },
    });
    if (!pairing) {
      throw ApiError.badRequest('invalid_pairing_code', 'This pairing code is not valid');
    }
    if (pairing.usedAt) {
      throw ApiError.conflict('pairing_used', 'This pairing code has already been used');
    }
    if (pairing.expiresAt.getTime() <= Date.now()) {
      throw ApiError.badRequest('pairing_expired', 'This pairing code has expired');
    }

    const subject = pairing.subject;
    const tenant = subject.tenant;
    if (tenant.disabled) throw ApiError.forbidden('This tenant is disabled', 'tenant_disabled');

    const device = await prisma.$transaction(async tx => {
      // The `usedAt: null` filter is the race guard: two phones scanning the
      // same QR code both arrive here, and only one of them matches a row.
      const claimed = await tx.pairingCode.updateMany({
        where: { id: pairing.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) {
        throw ApiError.conflict('pairing_used', 'This pairing code has already been used');
      }

      const live = await tx.device.count({ where: { subjectId: subject.id, revokedAt: null } });
      if (live >= tenant.deviceCap) {
        // Throwing rolls the claim back, so the user can unpair a phone and
        // scan the very same code again rather than starting over.
        throw ApiError.conflict(
          'device_cap_reached',
          `This account already has ${tenant.deviceCap} paired device(s)`,
        );
      }

      return tx.device.create({
        data: {
          id: randomId('dev'),
          subjectId: subject.id,
          label: body.label,
          platform: body.platform,
          model: body.model ?? null,
          devicePubKey,
          approvalPubKey,
          pushToken: body.pushToken ?? null,
        },
      });
    });

    // Every phone already on the account is told. A silently added device is
    // exactly what someone with a stolen QR code would hope for.
    const others = await prisma.device.findMany({
      where: { subjectId: subject.id, revokedAt: null, id: { not: device.id } },
    });
    await sendDeviceAddedPush({
      devices: others,
      brandName: tenant.brandName,
      newDeviceLabel: device.label,
    }).catch(() => undefined);

    await recordAudit({
      tenantId: tenant.id,
      subjectId: subject.id,
      type: 'device.paired',
      data: { deviceId: device.id, platform: device.platform, pairingId: pairing.id },
    });

    res.status(201).json({
      device: { id: device.id, label: device.label },
      subject: { label: subject.label, externalId: subject.externalId },
      tenant: {
        brandName: tenant.brandName,
        brandLogoUrl: tenant.brandLogoUrl,
        brandColor: tenant.brandColor,
      },
    });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * PATCH /v1/devices/me — the phone renames itself or refreshes its push token.
 * Registered before `/:id` so "me" is never read as a device id.
 */
devicesRouter.patch('/me', deviceAuth, async (req, res, next) => {
  try {
    const body = updateDeviceSchema.parse(req.body);
    const device = await prisma.device.update({
      where: { id: req.device!.id },
      data: {
        label: body.label,
        pushToken: body.pushToken,
        // A token the app has just handed us supersedes whatever made the
        // previous one look dead.
        pushFailedAt: body.pushToken === undefined ? undefined : null,
      },
    });
    res.json({ device: publicDevice(device) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** DELETE /v1/devices/me — the phone unpairs itself from Settings. */
devicesRouter.delete('/me', deviceAuth, async (req, res, next) => {
  try {
    const device = req.device!;
    const revokedAt = await revokeDevice(device);
    await recordAudit({
      tenantId: device.subject.tenantId,
      subjectId: device.subjectId,
      type: 'device.revoked',
      data: { deviceId: device.id, by: 'device' },
    });
    res.json({ device: { id: device.id, revokedAt } });
  } catch (err) {
    next(toApiError(err));
  }
});

/** GET /v1/devices?externalId=… — what the portal shows on the Approvals page. */
devicesRouter.get('/', integratorAuth, async (req, res, next) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const subject = await prisma.subject.findUnique({
      where: { tenantId_externalId: { tenantId: req.tenant!.id, externalId: query.externalId } },
      include: {
        devices: { where: { revokedAt: null }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!subject) throw ApiError.notFound('No such subject');
    res.json({ devices: subject.devices.map(publicDevice) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** DELETE /v1/devices/:id — the portal revokes a phone the customer has lost. */
devicesRouter.delete('/:id', integratorAuth, async (req, res, next) => {
  try {
    // findFirst through the subject, so another tenant's device is simply absent.
    const device = await prisma.device.findFirst({
      where: { id: req.params.id, subject: { tenantId: req.tenant!.id } },
      include: { subject: true },
    });
    if (!device) throw ApiError.notFound('No such device');

    const wasLive = !device.revokedAt;
    const revokedAt = await revokeDevice(device);
    if (wasLive) {
      await recordAudit({
        tenantId: device.subject.tenantId,
        subjectId: device.subjectId,
        type: 'device.revoked',
        data: { deviceId: device.id, by: 'integrator' },
      });
    }
    res.json({ device: { id: device.id, revokedAt } });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * Revoking is a one-way door and idempotent: a second call keeps the original
 * timestamp, because that is when the phone actually lost access.
 */
async function revokeDevice(device: { id: string; revokedAt: Date | null }): Promise<Date> {
  if (device.revokedAt) return device.revokedAt;
  const updated = await prisma.device.update({
    where: { id: device.id },
    // The push token goes with it — a revoked phone must stop being notified.
    data: { revokedAt: new Date(), pushToken: null },
  });
  return updated.revokedAt!;
}

/**
 * The app registers raw 32-byte Ed25519 keys. Anything else would only fail at
 * signature-verification time, long after pairing appeared to work.
 */
function requireEd25519Key(value: string, field: string): string {
  if (fromBase64url(value).length !== 32) {
    throw ApiError.badRequest(
      'invalid_public_key',
      `${field} must be a 32-byte Ed25519 public key in base64url`,
    );
  }
  return value;
}

function publicDevice(device: {
  id: string;
  label: string;
  platform: string;
  model: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  pushToken: string | null;
}) {
  return {
    id: device.id,
    label: device.label,
    platform: device.platform,
    model: device.model,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    // The token itself never leaves the server; the portal only needs to know
    // whether this phone can be reached.
    pushEnabled: Boolean(device.pushToken),
  };
}
