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
import { GRANT_WINDOWS_SEC, clampGrantWindow, createGrant, isGrantWindow } from '../services/policy';
import { sendRequestSettledPush } from '../services/push';
import { queueDecisionWebhook } from '../services/webhooks';
import { toApiError } from './tenants';

export const deviceRequestsRouter = Router();

// Phone-facing: every call is signed by the device key. Applied to the whole
// router so a new endpoint cannot be added unauthenticated by accident.
deviceRequestsRouter.use(deviceAuth);

const decisionSchema = z
  .object({
    decision: z.enum(['approved', 'denied']),
    scope: z.enum(['once', 'window']),
    /**
     * How long the phone is granting, in seconds. Absent means 0, the only
     * value `once` may carry. It is part of the signed message, so a value
     * changed in flight fails the signature rather than widening the grant.
     */
    windowSec: z.number().int().nonnegative().max(config.maxGrantWindowSec).default(0),
    /** Unix seconds, as a string: it is signed verbatim, so it must not be reformatted. */
    signedAt: z.string().regex(/^\d{1,12}$/, 'signedAt must be unix seconds'),
    signature: z.string().min(1).max(200),
  })
  // The set of windows is closed. An unlisted duration is a client that has
  // drifted from the protocol, and guessing what it meant is how a five-minute
  // approval turns into an afternoon of them.
  .superRefine((body, ctx) => {
    if (body.scope === 'once') {
      if (body.windowSec !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['windowSec'],
          message: 'A decision with scope "once" carries no window',
        });
      }
      return;
    }
    if (!isGrantWindow(body.windowSec)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['windowSec'],
        message: `windowSec must be one of ${GRANT_WINDOWS_SEC.join(', ')}`,
      });
    }
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
        // The phone offers no window longer than this, so it can never present
        // a choice the server is going to refuse or quietly shorten.
        maxWindowSec: device.subject.tenant.maxGrantWindowSec,
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
 * approving arguments it was never shown. It covers `windowSec` too: how long
 * the approval lasts is part of the decision, not a parameter of it.
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
      // The window the phone showed the person. It is signed, so a decision
      // captured on the way past cannot be stretched into a longer grant.
      windowSec: body.windowSec,
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

    // Nothing is granted by a denial, whatever window it carried. The phone was
    // told the tenant ceiling when it opened this request, so clamping here
    // should be rare — but a client that ignores it gets the short window.
    const asked = body.decision === 'approved' ? body.windowSec : 0;
    const allowed = clampGrantWindow(asked, device.subject.tenant.maxGrantWindowSec);
    // What was actually done, which is what the integrator is told: a window
    // clamped away to nothing is an approval of this one call and no more.
    const effectiveScope = allowed.windowSec > 0 ? 'window' : 'once';

    // First decision wins. Every phone on the account is notified, so two people
    // can answer at once; the conditional update is what makes that safe.
    const { count } = await prisma.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: {
        status: body.decision,
        decidedAt: now,
        decisionScope: effectiveScope,
        decisionWindowSec: allowed.windowSec > 0 ? allowed.windowSec : null,
      },
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
        // The signed answer, recorded as it was signed — not as it was clamped.
        scope: body.scope,
        windowSec: body.windowSec,
        signature: body.signature,
        signedAt: new Date(Number(body.signedAt) * 1000),
      },
    });

    // "Approve for a while": a batch of identical calls then asks once.
    const grant =
      allowed.windowSec > 0
        ? await createGrant(device.subjectId, request.resourceKey, allowed.windowSec, now)
        : null;

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
        scope: effectiveScope,
        requestedWindowSec: body.windowSec,
        windowSec: allowed.windowSec,
        deviceId: device.id,
      },
    });

    res.json({
      request: { id: request.id, status: body.decision, decidedAt: now },
      // Said out loud rather than silently applied: the phone promised the
      // person a duration, and if the tenant shortened it they should be told.
      grant:
        body.decision === 'approved' && body.scope === 'window'
          ? {
              windowSec: allowed.windowSec,
              requestedWindowSec: body.windowSec,
              maxWindowSec: allowed.maxWindowSec,
              clamped: allowed.clamped,
              expiresAt: grant?.expiresAt ?? null,
            }
          : null,
    });
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
