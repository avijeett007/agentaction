import { prisma } from '../prisma';
import { randomId } from '../lib/crypto';
import { logger } from '../logger';

/** Append-only history. Never throws: an audit failure must not fail a request. */
export async function recordAudit(input: {
  tenantId: string;
  subjectId?: string | null;
  type: string;
  data: Record<string, unknown>;
}): Promise<void> {
  try {
    await prisma.auditEvent.create({
      data: {
        id: randomId('evt'),
        tenantId: input.tenantId,
        subjectId: input.subjectId ?? null,
        type: input.type,
        dataJson: JSON.stringify(input.data),
      },
    });
  } catch (err) {
    logger.warn('audit write failed', {
      type: input.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
