import { prisma } from '../../src/prisma';

/** Empties every table, children first. Called between tests. */
export async function resetDb(): Promise<void> {
  await prisma.$transaction([
    prisma.webhookDelivery.deleteMany(),
    prisma.decision.deleteMany(),
    prisma.approvalRequest.deleteMany(),
    prisma.grant.deleteMany(),
    prisma.policy.deleteMany(),
    prisma.pairingCode.deleteMany(),
    prisma.device.deleteMany(),
    prisma.subject.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.tenant.deleteMany(),
  ]);
}
