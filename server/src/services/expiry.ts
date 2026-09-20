import { prisma } from '../prisma';
import { logger } from '../logger';

/**
 * Backstop for requests nobody answered.
 *
 * Reads expire lazily on the way past, so this sweeper exists for the rows
 * nobody ever looks at again — otherwise a forgotten request would sit
 * "pending" forever and clutter every phone's list.
 */

const INTERVAL_MS = 30_000;

/** Marks every overdue pending request expired. Returns how many it closed. */
export async function expireOverdue(now: Date = new Date()): Promise<number> {
  try {
    const { count } = await prisma.approvalRequest.updateMany({
      // Conditional on pending, so a decision landing at the same moment wins.
      where: { status: 'pending', expiresAt: { lte: now } },
      data: { status: 'expired' },
    });
    if (count > 0) logger.info('approval requests expired', { count });
    return count;
  } catch (err) {
    logger.warn('expiry sweep failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** Started by index.ts. The timer is unref'd so shutdown is never blocked. */
export function startExpirySweeper(intervalMs: number = INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    void expireOverdue();
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
