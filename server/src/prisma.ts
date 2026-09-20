import { PrismaClient } from '@prisma/client';

declare global {
  // eslint-disable-next-line no-var
  var __agentactionPrisma: PrismaClient | undefined;
}

/** One client per process; survives tsx watch reloads. */
export const prisma: PrismaClient =
  global.__agentactionPrisma ?? new PrismaClient({ log: ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') global.__agentactionPrisma = prisma;
