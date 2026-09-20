/**
 * Pairing: turning a QR code shown in the portal into an account on this phone.
 *
 * Parsing is kept separate from the camera so a malformed or hostile payload
 * is rejected by a tested pure function, not by a screen.
 */
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { createDeviceClient, registerDevice } from './api';
import type { Account, Brand } from './accounts';
import { addAccount, removeAccount } from './accounts';
import { createKeys, deleteKeys, signWithDeviceKey } from './keys';
import { NEUTRAL_BRAND } from './theme';

export interface PairingPayload {
  v: 1;
  serverUrl: string;
  secret: string;
  tenantId: string;
  brand: Brand;
  subject: { label: string };
}

export class PairingPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingPayloadError';
  }
}

const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Validates a scanned QR payload. Anything a camera can see is untrusted
 * input: a passer-by can hold up a poster, so we insist on our own shape and
 * on an https server before we send a secret anywhere.
 */
export function parsePairingPayload(text: string): PairingPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new PairingPayloadError('That QR code is not an AgentAction pairing code.');
  }

  const p = raw as Partial<PairingPayload>;
  if (!p || typeof p !== 'object') {
    throw new PairingPayloadError('That QR code is not an AgentAction pairing code.');
  }
  if (p.v !== 1) {
    throw new PairingPayloadError('This pairing code needs a newer version of AgentAction.');
  }
  const serverUrl = typeof p.serverUrl === 'string' ? safeServerUrl(p.serverUrl) : null;
  if (!serverUrl) {
    throw new PairingPayloadError('That pairing code points somewhere unsafe.');
  }
  if (typeof p.secret !== 'string' || p.secret.length < 16) {
    throw new PairingPayloadError('That pairing code is incomplete.');
  }
  if (typeof p.tenantId !== 'string' || !p.tenantId) {
    throw new PairingPayloadError('That pairing code is incomplete.');
  }
  if (!p.subject || typeof p.subject.label !== 'string' || !p.subject.label) {
    throw new PairingPayloadError('That pairing code is missing the account it belongs to.');
  }

  return {
    v: 1,
    serverUrl,
    secret: p.secret,
    tenantId: p.tenantId,
    subject: { label: p.subject.label },
    brand: normaliseBrand(p.brand),
  };
}

const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const PRIVATE_10 = new RegExp(`^10(?:\\.${OCTET}){3}$`);
const PRIVATE_192 = new RegExp(`^192\\.168(?:\\.${OCTET}){2}$`);

function isLoopbackOrPrivate(host: string): boolean {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host === '::1' ||
    PRIVATE_10.test(host) ||
    PRIVATE_192.test(host)
  );
}

/**
 * Validates the server a QR code points at, returning the normalised URL or
 * null.
 *
 * This is the most security-sensitive line in the app: whoever controls
 * `serverUrl` controls which server receives the pairing secret and every
 * signed call afterwards, and a QR code is something a stranger can print on a
 * poster. So the host is *parsed*, never pattern-matched — `http://10.evil.com`
 * and `http://localhost.evil.com` both start with an allowed prefix while
 * resolving to an attacker's machine, and `https://trusted@evil.com` reads as
 * trustworthy while the real host is after the `@`.
 *
 * Plain http is allowed only for a loopback or RFC 1918 address, so the server
 * lane can pair against a laptop. Everything else must be TLS.
 */
export function safeServerUrl(value: string): string | null {
  // No whitespace and no backslashes: neither belongs in a pairing URL, and
  // both are the raw material for parser-confusion tricks.
  if (/[\s\\]/.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== 'https:' && protocol !== 'http:') return null;
  // Userinfo before the @ is not the host; a URL that carries it is either
  // confused or trying to confuse us.
  if (parsed.username || parsed.password) return null;

  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return null;
  if (protocol === 'http:' && !isLoopbackOrPrivate(host)) return null;

  // Keep the origin and path the portal issued, minus query, fragment and any
  // trailing slash, so the paths we sign are appended exactly.
  return value.split('#')[0].split('?')[0].replace(/\/+$/, '');
}

/**
 * A pairing code that names no brand, or names one in a colour we cannot use,
 * falls back to AgentAction's own identity — the same one the app wears before
 * anything is paired — rather than to a second, unrelated grey.
 */
export function normaliseBrand(brand: Partial<Brand> | undefined): Brand {
  return {
    name: typeof brand?.name === 'string' && brand.name ? brand.name : NEUTRAL_BRAND.name,
    logoUrl: typeof brand?.logoUrl === 'string' && /^https:\/\//.test(brand.logoUrl) ? brand.logoUrl : null,
    color: typeof brand?.color === 'string' && HEX_COLOUR.test(brand.color) ? brand.color : NEUTRAL_BRAND.color,
  };
}

/** A default name for this phone on the account; the owner can rename it. */
export function defaultDeviceLabel(): string {
  const name = Device.deviceName || Device.modelName;
  return name || `${Platform.OS === 'ios' ? 'iPhone' : 'Android phone'}`;
}

export interface CompletePairingInput {
  payload: PairingPayload;
  label: string;
  pushToken?: string | null;
}

/**
 * Generates the keys, registers them and stores the account. If registration
 * fails the fresh keys are deleted, so a retry does not leave the keychain
 * littered with orphans.
 */
export async function completePairing(input: CompletePairingInput): Promise<Account> {
  const keys = await createKeys();
  try {
    const result = await registerDevice(input.payload.serverUrl, {
      secret: input.payload.secret,
      devicePubKey: keys.devicePubKey,
      approvalPubKey: keys.approvalPubKey,
      label: input.label,
      platform: Platform.OS,
      model: Device.modelName ?? undefined,
      pushToken: input.pushToken ?? undefined,
    });

    const account: Account = {
      deviceId: result.device.id,
      serverUrl: input.payload.serverUrl,
      subjectLabel: result.subject?.label || input.payload.subject.label,
      deviceLabel: result.device.label || input.label,
      // The server's branding wins over the QR's: the QR may be minutes old.
      brand: {
        name: result.tenant?.brandName || input.payload.brand.name,
        logoUrl: result.tenant?.brandLogoUrl ?? input.payload.brand.logoUrl,
        color: result.tenant?.brandColor || input.payload.brand.color,
      },
      createdAt: new Date().toISOString(),
      keyRef: keys.keyRef,
      approvalKeyMode: keys.approvalKeyMode,
      pushToken: input.pushToken ?? null,
    };
    await addAccount(account);
    return account;
  } catch (err) {
    await deleteKeys(keys.keyRef);
    throw err;
  }
}

/** Builds the signed client for an account. */
export function clientFor(account: Account) {
  return createDeviceClient({
    serverUrl: account.serverUrl,
    deviceId: account.deviceId,
    signDevice: message => signWithDeviceKey(account.keyRef, message),
  });
}

/**
 * Tells the server to forget this phone, then forgets the server.
 * The local half happens even if the server call fails — otherwise a revoked
 * or unreachable account can never be removed from the phone.
 */
export async function unpairAccount(account: Account): Promise<{ serverNotified: boolean }> {
  let serverNotified = false;
  try {
    await clientFor(account).unpair();
    serverNotified = true;
  } catch {
    serverNotified = false;
  }
  await deleteKeys(account.keyRef);
  await removeAccount(account.deviceId);
  return { serverNotified };
}
