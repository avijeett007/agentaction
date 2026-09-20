import crypto from 'crypto';
import { base64url, deviceRequestMessage } from '../../src/lib/crypto';

export interface TestKeyPair {
  /** Raw 32-byte public key, base64url — the form the app registers. */
  publicKey: string;
  sign(message: string): string;
}

/** An Ed25519 keypair standing in for one held on a phone. */
export function makeKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  return {
    publicKey: jwk.x,
    sign: (message: string) =>
      base64url(crypto.sign(null, Buffer.from(message, 'utf8'), privateKey)),
  };
}

/** Headers a phone sends so the server can verify the call came from it. */
export function deviceHeaders(
  deviceId: string,
  keys: TestKeyPair,
  method: string,
  path: string,
  body?: unknown,
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const signature = keys.sign(deviceRequestMessage(method, path, String(timestamp), raw));
  return {
    'x-aa-device': deviceId,
    'x-aa-timestamp': String(timestamp),
    'x-aa-signature': signature,
  };
}

export { base64url };
