import { Router } from 'express';
import { z } from 'zod';
import type { ApprovalRequest, Decision } from '@prisma/client';
import { prisma } from '../prisma';
import { config } from '../config';
import { numericCode, randomId } from '../lib/crypto';
import { ApiError } from '../lib/errors';
import { logger } from '../logger';
import { integratorAuth } from '../middleware/integratorAuth';
import { recordAudit } from '../services/audit';
import { sendApprovalRequestPush } from '../services/push';
import { toApiError } from './tenants';

export const requestsRouter = Router();

/** The agent never waits longer than this, so a held connection cannot leak. */
const MAX_WAIT_SEC = 50;
const DEFAULT_WAIT_SEC = 30;
/** How often a long poll re-reads the row. Cheap: one indexed lookup. */
const WAIT_POLL_MS = 500;

const fieldSchema = z.object({
  label: z.string().min(1).max(200),
  value: z.string().max(8000),
  sensitive: z.boolean().optional(),
});

const createRequestSchema = z.object({
  /** The integrator's own id for the account — your own customer or user id. */
  externalId: z.string().min(1).max(200),
  actorLabel: z.string().min(1).max(200),
  resourceKey: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  fields: z.array(fieldSchema).max(50).default([]),
  /** sha256 of the canonical arguments. The phone signs this exact value. */
  argsHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'argsHash must be a sha256 hex digest'),
  /** Any positive value is accepted and then clamped, so an odd number from a
   *  caller shortens or lengthens the window rather than failing the call. */
  ttlSec: z.number().int().positive().optional(),
});

const waitQuerySchema = z.object({
  timeout: z.coerce.number().int().min(0).max(3600).optional(),
});

/**
 * POST /v1/requests — park one tool call and ring the phones.
 *
 * The integrator keeps the real arguments; we only ever see a display payload
 * and their hash, so an approval can prove what was approved without this
 * server being able to run it.
 */
requestsRouter.post('/', integratorAuth, async (req, res, next) => {
  try {
    const body = createRequestSchema.parse(req.body);
    const tenant = req.tenant!;

    const subject = await prisma.subject.findUnique({
      where: { tenantId_externalId: { tenantId: tenant.id, externalId: body.externalId } },
      include: { devices: { where: { revokedAt: null } } },
    });
    // Also the cross-tenant answer: a key only ever resolves its own subjects.
    if (!subject) throw ApiError.notFound('No such subject');

    const now = new Date();

    // An agent that retries the same call must not put a second notification on
    // the phone. Same subject, same tool, same arguments, still open — reuse it.
    const open = await prisma.approvalRequest.findFirst({
      where: {
        subjectId: subject.id,
        resourceKey: body.resourceKey,
        argsHash: body.argsHash,
        status: 'pending',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      res.status(201).json({ request: createdRequest(open), deduplicated: true });
      return;
    }

    // A tenant may shorten or lengthen the window, but never outside the bounds
    // the operator set — a silly value must not effectively disable approval.
    const ttlSec = clamp(
      body.ttlSec ?? tenant.requestTtlSec,
      config.minRequestTtlSec,
      config.maxRequestTtlSec,
    );

    const request = await prisma.approvalRequest.create({
      data: {
        id: randomId('req'),
        subjectId: subject.id,
        actorLabel: body.actorLabel,
        resourceKey: body.resourceKey,
        title: body.title,
        fieldsJson: JSON.stringify(body.fields),
        argsHash: body.argsHash,
        code: numericCode(),
        status: 'pending',
        expiresAt: new Date(now.getTime() + ttlSec * 1000),
      },
    });

    // A push failure is a delivery problem, not a request failure: the phone
    // still finds the request in its pending list.
    const pushes = await sendApprovalRequestPush({
      devices: subject.devices,
      brandName: tenant.brandName,
      title: request.title,
      code: request.code,
      requestId: request.id,
    }).catch(err => {
      logger.warn('approval push failed', {
        requestId: request.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    });

    await recordAudit({
      tenantId: tenant.id,
      subjectId: subject.id,
      type: 'request.created',
      data: {
        requestId: request.id,
        resourceKey: request.resourceKey,
        actorLabel: request.actorLabel,
        ttlSec,
        devices: subject.devices.length,
        pushed: pushes.filter(p => p.ok).length,
      },
    });

    res.status(201).json({ request: createdRequest(request) });
  } catch (err) {
    next(toApiError(err));
  }
});

/** GET /v1/requests/:id — where one parked call has got to. */
requestsRouter.get('/:id', integratorAuth, async (req, res, next) => {
  try {
    const state = await loadState(req.tenant!.id, req.params.id);
    res.json({ request: state });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * GET /v1/requests/:id/wait?timeout=30 — long poll for the outcome.
 *
 * Polling the row beats holding a transaction or a listener open: the
 * connection is the only thing kept, and a restart loses nothing.
 */
requestsRouter.get('/:id/wait', integratorAuth, async (req, res, next) => {
  try {
    const query = waitQuerySchema.parse(req.query);
    const waitSec = Math.min(query.timeout ?? DEFAULT_WAIT_SEC, MAX_WAIT_SEC);
    const tenantId = req.tenant!.id;
    const id = req.params.id;
    const deadline = Date.now() + waitSec * 1000;

    // If the caller hangs up there is nobody left to answer.
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    // Only the status column is polled; the full row is read once, at the end.
    while (!closed && Date.now() < deadline) {
      const row = await prisma.approvalRequest.findFirst({
        where: { id, subject: { tenantId } },
        select: { status: true, expiresAt: true },
      });
      if (!row) break; // Unknown id: the final load produces the 404.
      if (row.status !== 'pending') break;
      if (row.expiresAt.getTime() <= Date.now()) break; // The final load expires it.
      await sleep(Math.max(0, Math.min(WAIT_POLL_MS, deadline - Date.now())));
    }

    const state = await loadState(tenantId, id);
    if (closed) return; // Nothing to write to.
    res.json({ request: state });
  } catch (err) {
    next(toApiError(err));
  }
});

/**
 * Reads one request for this tenant, expiring it on the way past if its time
 * is up. The sweeper is only a backstop: nobody should ever be told a request
 * is pending when it can no longer be decided.
 */
async function loadState(tenantId: string, id: string) {
  const request = await prisma.approvalRequest.findFirst({
    where: { id, subject: { tenantId } },
    include: { decisions: true },
  });
  if (!request) throw ApiError.notFound('No such request');

  if (request.status === 'pending' && request.expiresAt.getTime() <= Date.now()) {
    // Conditional on pending, so a decision landing in the same millisecond wins.
    const { count } = await prisma.approvalRequest.updateMany({
      where: { id: request.id, status: 'pending' },
      data: { status: 'expired' },
    });
    if (count > 0) return publicState({ ...request, status: 'expired' }, request.decisions);
    const fresh = await prisma.approvalRequest.findUnique({
      where: { id: request.id },
      include: { decisions: true },
    });
    if (fresh) return publicState(fresh, fresh.decisions);
  }

  return publicState(request, request.decisions);
}

/** What the agent is handed the moment its call is parked. */
function createdRequest(request: ApprovalRequest) {
  return {
    id: request.id,
    code: request.code,
    status: request.status,
    expiresAt: request.expiresAt,
    createdAt: request.createdAt,
  };
}

/** What a status read or a finished long poll returns. */
function publicState(request: ApprovalRequest, decisions: Decision[]) {
  return {
    id: request.id,
    status: request.status,
    code: request.code,
    expiresAt: request.expiresAt,
    decidedAt: request.decidedAt,
    decisionScope: request.decisionScope,
    /** How long the grant lasts, in seconds. Null when the answer was `once`. */
    decisionWindowSec: request.decisionWindowSec,
    resourceKey: request.resourceKey,
    title: request.title,
    argsHash: request.argsHash,
    decidedByDeviceId: decisions[0]?.deviceId,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
