import { prisma } from '../../src/prisma';
import { generateApiKey, randomId, randomSecret } from '../../src/lib/crypto';
import { makeKeyPair, type TestKeyPair } from './keys';

export async function createTenant(
  overrides: Partial<{
    deviceCap: number;
    webhookUrl: string;
    requestTtlSec: number;
    /** The longest "approve for a while" window this agency accepts. */
    maxGrantWindowSec: number;
  }> = {},
) {
  const { key, hash } = generateApiKey();
  const tenant = await prisma.tenant.create({
    data: {
      id: randomId('ten'),
      name: 'Test Agency',
      brandName: 'Test Agency',
      brandColor: '#112233',
      apiKeyHash: hash,
      webhookSecret: randomSecret(),
      webhookUrl: overrides.webhookUrl ?? null,
      deviceCap: overrides.deviceCap ?? 5,
      requestTtlSec: overrides.requestTtlSec ?? 600,
      maxGrantWindowSec: overrides.maxGrantWindowSec ?? 3600,
    },
  });
  return { tenant, apiKey: key };
}

export async function createSubject(tenantId: string, externalId = 'cust_1') {
  return prisma.subject.create({
    data: {
      id: randomId('sub'),
      tenantId,
      externalId,
      label: 'Acme Dental',
      email: 'owner@acme.test',
    },
  });
}

export async function createDevice(
  subjectId: string,
  keys: { device?: TestKeyPair; approval?: TestKeyPair } = {},
) {
  const deviceKeys = keys.device ?? makeKeyPair();
  const approvalKeys = keys.approval ?? makeKeyPair();
  const device = await prisma.device.create({
    data: {
      id: randomId('dev'),
      subjectId,
      label: "Owner's iPhone",
      platform: 'ios',
      model: 'iPhone16,1',
      devicePubKey: deviceKeys.publicKey,
      approvalPubKey: approvalKeys.publicKey,
      pushToken: 'ExponentPushToken[test-token]',
    },
  });
  return { device, deviceKeys, approvalKeys };
}
