import { Router } from 'express';
import { z } from 'zod';
import type { ApprovalRequest } from '@prisma/client';
import { prisma } from '../prisma';
import { config } from '../config';
import { decisionMessage, randomId, verifyEd25519 } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { logger } from '../logger';
import { deviceAuth } from '../middleware/deviceAuth';
import { recordAudit } from '../services/audit';
import { sendRequestSettledPush } from '../services/push';
import { queueDecisionWebhook } from '../services/webhooks';
import { toApiError } from './tenants';

export const deviceRequestsRouter = Router();

// Phone-facing: every call is signed by the device key. Applied to the whole
// router so a new endpoint cannot be added unauthenticated by accident.
deviceRequestsRouter.use(deviceAuth);

const decisionSchema = z.object({
  decision: z.enum(['approved', 'denied']),
  scope: z.enum(['once', 'window']),
  /** Unix seconds, as a string: it is signed verbatim, so it must not be reformatted. */
  signedAt: z.string().regex(/^\d{1,12}$/, 'signedAt must be unix seconds'),
  signature: z.string().min(1).max(200),
});

/** GET /v1/device/requests — what this phone is being asked to decide. */
deviceRequestsRouter.get('/', async (req, res, next) => {
  try {
    const device = req.device!;
    const requests = await prisma.approvalRequest.findMany({
      where: { subjectId: device.subjectId, status: 'pending', expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      requests: requests.map(request => ({
        id: request.id,
        title: request.title,
        code: request.code,
        resourceKey: request.resourceKey,
        actorLabel: request.actorLabel,
        expiresAt: request.expiresAt,
        createdAt: request.createdAt,
        // The list is rendered per account, so each row carries its brand.
        brandName: device.subject.tenant.brandName,
      })),
    });
    // The arguments are deliberately absent here: they are only fetched when
    // the user opens one request.
  } catch (err) {
    next(toApiError(err));
  }
});

/** GET /v1/device/requests/:id — the approval screen, arguments included. */
deviceRequestsRouter.get('/:id', async (req, res, next) => {
  try {
    const device = req.device!;
    const request = await findForDevice(device.subjectId, req.params.id);
    res.json({
      request: {
        ...publicRequest(request),
        brandName: device.subject.tenant.brandName,
        fields: parseFields(request.fieldsJson),
      },
    });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * POST /v1/device/requests/:id/decision — approve or deny, signed.
 *
 * The signature covers the stored arguments hash, so a decision captured from
 * one call cannot be replayed onto another, and a phone cannot be tricked into
 * approving arguments it was never shown.
 */
deviceRequestsRouter.post('/:id/decision', async (req, res, next) => {
  try {
    const body = decisionSchema.parse(req.body);
    const device = req.device!;
    const request = await findForDevice(device.subjectId, req.params.id);

    // Same window as the device-auth signature: an old signed decision is not
    // allowed to surface later.
    const skewSec = Math.abs(Date.now() / 1000 - Number(body.signedAt));
    if (!Number.isFinite(skewSec) || skewSec > config.signatureSkewSec) {
      throw ApiError.unauthorized('Decision signed too long ago', 'stale_signature');
    }

    const message = decisionMessage({
      requestId: request.id,
      decision: body.decision,
      scope: body.scope,
      argsHash: request.argsHash, // Ours, never the caller's.
      signedAt: body.signedAt,
    });
    if (!verifyEd25519(device.approvalPubKey, message, body.signature)) {
      throw ApiError.unauthorized('Bad decision signature', 'bad_signature');
    }

    const now = new Date();
    if (request.status !== 'pending') {
      throw ApiError.conflict('already_decided', 'This request has already been decided');
    }
    if (request.expiresAt.getTime() <= now.getTime()) {
      await prisma.approvalRequest.updateMany({
        where: { id: request.id, status: 'pending' },
        data: { status: 'expired' },
      });
      throw ApiError.conflict('expired', 'This request has expired');
    }

    // First decision wins. Every phone on the account is notified, so two people
    // can answer at once; the conditional update is what makes that safe.
    const { count } = await prisma.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: body.decision, decidedAt: now, decisionScope: body.scope },
    });
    if (count === 0) {
      throw ApiError.conflict('already_decided', 'This request has already been decided');
    }

    await prisma.decision.create({
      data: {
        id: randomId('dec'),
        requestId: request.id,
        deviceId: device.id,
        decision: body.decision,
        scope: body.scope,
        signature: body.signature,
        signedAt: new Date(Number(body.signedAt) * 1000),
      },
    });

    // "Approve for a while": a batch of identical calls then asks once.
    if (body.decision === 'approved' && body.scope === 'window') {
      await prisma.grant.create({
        data: {
          id: randomId('grn'),
          subjectId: device.subjectId,
          resourceKey: request.resourceKey,
          expiresAt: new Date(now.getTime() + config.grantWindowSec * 1000),
        },
      });
    }

    await queueDecisionWebhook(request.id);

    // Quietly clears the notification on the phones that did not answer.
    const others = await prisma.device.findMany({
      where: { subjectId: device.subjectId, revokedAt: null, id: { not: device.id } },
    });
    if (others.length > 0) {
      await sendRequestSettledPush({
        devices: others,
        requestId: request.id,
        decision: body.decision,
        decidedByLabel: device.label,
      }).catch(err => {
        logger.warn('settled push failed', {
          requestId: request.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      });
    }

    await recordAudit({
      tenantId: device.subject.tenantId,
      subjectId: device.subjectId,
      type: 'request.decided',
      data: {
        requestId: request.id,
        resourceKey: request.resourceKey,
        decision: body.decision,
        scope: body.scope,
        deviceId: device.id,
      },
    });

    res.json({ request: { id: request.id, status: body.decision, decidedAt: now } });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * One request belonging to this phone's account. A request from another
 * subject is answered exactly as an unknown id: nothing leaks across accounts,
 * not even the fact that the id exists.
 */
async function findForDevice(subjectId: string, id: string): Promise<ApprovalRequest> {
  const request = await prisma.approvalRequest.findFirst({ where: { id, subjectId } });
  if (!request) throw ApiError.notFound('No such request');
  return request;
}

function publicRequest(request: ApprovalRequest) {
  return {
    id: request.id,
    title: request.title,
    code: request.code,
    resourceKey: request.resourceKey,
    actorLabel: request.actorLabel,
    argsHash: request.argsHash,
    status: request.status,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  };
}

/**
 * The display payload as the app expects it. Values are forced to strings: the
 * app renders them as plain text, never as markup, and a stored blob that is
 * somehow malformed must not break the approval screen.
 */
function parseFields(fieldsJson: string): { label: string; value: string; sensitive: boolean }[] {
  try {
    const parsed: unknown = JSON.parse(fieldsJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(entry => {
      const field = (entry ?? {}) as { label?: unknown; value?: unknown; sensitive?: unknown };
      return {
        label: String(field.label ?? ''),
        value: String(field.value ?? ''),
        sensitive: Boolean(field.sensitive),
      };
    });
  } catch {
    return [];
  }
}
