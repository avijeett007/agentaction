import type { RequestHandler } from 'express';
import type { Device, Subject, Tenant } from '@prisma/client';
import { prisma } from '../prisma';
import { deviceRequestMessage, verifyEd25519 } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { config } from '../config';

declare module 'express-serve-static-core' {
  interface Request {
    device?: Device & { subject: Subject & { tenant: Tenant } };
  }
}

/**
 * Authenticates the phone. Every call carries a signature made by the device
 * key, so there is no bearer token on the phone that could be stolen and
 * replayed from somewhere else.
 *
 * Headers: x-aa-device, x-aa-timestamp (unix seconds), x-aa-signature.
 */
export const deviceAuth: RequestHandler = async (req, _res, next) => {
  try {
    const deviceId = req.header('x-aa-device');
    const timestamp = req.header('x-aa-timestamp');
    const signature = req.header('x-aa-signature');
    if (!deviceId || !timestamp || !signature) {
      throw ApiError.unauthorized('Missing device signature headers');
    }

    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(skew) || skew > config.signatureSkewSec) {
      throw ApiError.unauthorized('Signature timestamp out of range', 'stale_signature');
    }

    const device = await prisma.device.findUnique({
      where: { id: deviceId },
      include: { subject: { include: { tenant: true } } },
    });
    if (!device || device.revokedAt) throw ApiError.unauthorized('Unknown or revoked device');

    // req.originalUrl keeps the query string, which is part of what was signed.
    const message = deviceRequestMessage(
      req.method,
      req.originalUrl.split('?')[0],
      timestamp,
      req.rawBody ?? '',
    );
    if (!verifyEd25519(device.devicePubKey, message, signature)) {
      throw ApiError.unauthorized('Bad device signature', 'bad_signature');
    }

    req.device = device;
    void prisma.device
      .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    next();
  } catch (err) {
    next(err);
  }
};
