import type { WebhookDelivery } from '@prisma/client';
import { prisma } from '../prisma';
import { randomId, signWebhook } from '../lib/crypto';
import { logger } from '../logger';

/**
 * Outbound decision webhooks.
 *
 * The integrator does not trust this as the only path — it reconciles by
 * polling — so the job here is to be prompt and to give up quietly rather than
 * to guarantee delivery.
 */

/** Seconds to wait after attempt 1, 2, 3, 4, 5. Attempt 6 is the last. */
const BACKOFF_SEC = [5, 30, 120, 600, 1800];
const MAX_ATTEMPTS = 6;
const REQUEST_TIMEOUT_MS = 10_000;
const BATCH = 50;
const INTERVAL_MS = 5_000;

export interface DeliveryRun {
  delivered: number;
  retrying: number;
  failed: number;
}

/**
 * Records that a decision needs sending. A tenant with no webhookUrl simply
 * has no row: nothing to deliver, nothing to retry, nothing to sweep up.
 * Never throws — a queueing failure must not fail the decision that caused it.
 */
export async function queueDecisionWebhook(requestId: string): Promise<string | null> {
  try {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: requestId },
      include: { subject: { include: { tenant: true } } },
    });
    if (!request) return null;

    const url = request.subject.tenant.webhookUrl;
    if (!url) return null;

    const delivery = await prisma.webhookDelivery.create({
      data: {
        id: randomId('whd'),
        requestId,
        url,
        status: 'pending',
        // Due immediately; the worker picks it up on its next tick.
        nextAttempt: new Date(),
      },
    });
    return delivery.id;
  } catch (err) {
    logger.warn('queueing decision webhook failed', {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Sends every delivery that is due. Safe to call from a timer or a test:
 * it swallows its own failures and reports what it did.
 */
export async function deliverPending(now: Date = new Date()): Promise<DeliveryRun> {
  const run: DeliveryRun = { delivered: 0, retrying: 0, failed: 0 };
  try {
    const due = await prisma.webhookDelivery.findMany({
      where: {
        status: 'pending',
        OR: [{ nextAttempt: null }, { nextAttempt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: BATCH,
    });

    for (const delivery of due) {
      const outcome = await deliverOne(delivery, now);
      run[outcome] += 1;
    }
  } catch (err) {
    logger.warn('webhook sweep failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return run;
}

async function deliverOne(
  delivery: WebhookDelivery,
  now: Date,
): Promise<'delivered' | 'retrying' | 'failed'> {
  const attempt = delivery.attempts + 1;
  try {
    const request = await prisma.approvalRequest.findUnique({
      where: { id: delivery.requestId },
      include: { subject: { include: { tenant: true } } },
    });
    if (!request) {
      // The request went away: there is nothing left to tell anyone about.
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: { status: 'failed', attempts: attempt, lastError: 'request no longer exists' },
      });
      return 'failed';
    }

    const body = JSON.stringify({
      type: 'request.decided',
      requestId: request.id,
      subjectExternalId: request.subject.externalId,
      resourceKey: request.resourceKey,
      status: request.status,
      decisionScope: request.decisionScope,
      argsHash: request.argsHash,
      decidedAt: request.decidedAt ? request.decidedAt.toISOString() : null,
    });
    const timestamp = Math.floor(now.getTime() / 1000);

    const response = await post(delivery.url, body, {
      // Signed over these exact bytes: the receiver hashes the raw body.
      'x-agentaction-signature': signWebhook(request.subject.tenant.webhookSecret, timestamp, body),
      'content-type': 'application/json',
    });

    if (response.ok) {
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'delivered',
          attempts: attempt,
          deliveredAt: now,
          nextAttempt: null,
          lastError: null,
        },
      });
      return 'delivered';
    }

    return reschedule(delivery, attempt, now, `HTTP ${response.status}`);
  } catch (err) {
    return reschedule(delivery, attempt, now, err instanceof Error ? err.message : String(err));
  }
}

/** Backs off, or gives up once the attempts are used. Never throws. */
async function reschedule(
  delivery: WebhookDelivery,
  attempt: number,
  now: Date,
  lastError: string,
): Promise<'retrying' | 'failed'> {
  const backoff = BACKOFF_SEC[attempt - 1];
  const giveUp = attempt >= MAX_ATTEMPTS || backoff === undefined;
  try {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts: attempt,
        status: giveUp ? 'failed' : 'pending',
        nextAttempt: giveUp ? null : new Date(now.getTime() + backoff * 1000),
        lastError: lastError.slice(0, 500),
      },
    });
  } catch (err) {
    logger.warn('recording webhook failure failed', {
      deliveryId: delivery.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (giveUp) {
    logger.warn('webhook delivery abandoned', {
      deliveryId: delivery.id,
      requestId: delivery.requestId,
      attempts: attempt,
      lastError,
    });
  }
  return giveUp ? 'failed' : 'retrying';
}

/** One POST with a hard timeout, so a hung receiver cannot stall the sweep. */
async function post(url: string, body: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Unref'd: a pending timeout must never hold the process (or a test) open.
  timer.unref?.();
  try {
    return await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Started by index.ts. The timer is unref'd so shutdown is never blocked. */
export function startWebhookWorker(intervalMs: number = INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void deliverPending();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
