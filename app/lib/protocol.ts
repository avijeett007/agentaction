/**
 * The wire protocol: the exact bytes the AgentAction server verifies.
 *
 * Everything here is pure and dependency-free on purpose. A one-character
 * difference between what the phone signs and what the server rebuilds makes
 * every call fail with "bad signature", so these builders are kept in one
 * small file, mirrored from `server/src/lib/crypto.ts`, and asserted
 * byte-for-byte in the tests.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Base64url without padding, matching the server's `base64url()`.
 *
 * Hand-rolled because React Native has neither `Buffer` nor a guaranteed
 * `btoa`, and pulling a polyfill in for sixty bytes of logic is not worth it.
 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0b11) << 4) | ((b1 ?? 0) >> 4)];
    if (b1 === undefined) continue;
    out += B64URL_ALPHABET[((b1 & 0b1111) << 2) | ((b2 ?? 0) >> 6)];
    if (b2 === undefined) continue;
    out += B64URL_ALPHABET[b2 & 0b111111];
  }
  return out;
}

/** Accepts base64url or plain base64, padded or not. */
export function fromBase64Url(value: string): Uint8Array {
  const clean = value.replace(/-/g, '+').replace(/_/g, '/').replace(/[=\s]/g, '');
  const standard = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const out = new Uint8Array(Math.floor((clean.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let written = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const v = standard.indexOf(clean[i]);
    if (v < 0) throw new Error(`Not base64url: unexpected character at ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written] = (acc >> bits) & 0xff;
      written += 1;
    }
  }
  return out.slice(0, written);
}

export function utf8(value: string): Uint8Array {
  return utf8ToBytes(value);
}

/**
 * Lowercase hex SHA-256 of a UTF-8 string.
 *
 * Note that the empty body hashes to a real value — the hash of the empty
 * string — not to an empty field. The server signs `sha256Hex('')` for GET and
 * DELETE, so we must too.
 */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8ToBytes(input)));
}

/** The hash of an empty body, spelled out so a reader can check it by eye. */
export const SHA256_OF_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * What a device signs to authenticate one API call.
 * `path` is the path the server sees, without the query string.
 */
export function deviceRequestMessage(
  method: string,
  path: string,
  timestamp: string,
  body: string,
): string {
  return [method.toUpperCase(), path, timestamp, sha256Hex(body || '')].join('\n');
}

export type DecisionValue = 'approved' | 'denied';
export type DecisionScope = 'once' | 'window';

/**
 * The windows an approval may grant, shortest first.
 *
 * This list is part of the wire contract, not a presentation choice: the
 * server refuses any other value outright rather than rounding it, so the
 * phone must never offer one. Labels live in `windows.ts`.
 */
export const DECISION_WINDOWS_SEC = [300, 900, 3600, 28800] as const;
export type DecisionWindowSec = (typeof DECISION_WINDOWS_SEC)[number];

/** The window an approval that covers only this one call signs. */
export const NO_WINDOW_SEC = 0;

export interface DecisionMessageInput {
  requestId: string;
  decision: DecisionValue;
  scope: DecisionScope;
  /**
   * Seconds the grant will last; 0 when the scope is `once`. Signed, never
   * merely sent — see the note on the builder below.
   */
  windowSec: number;
  /** Comes back on the request detail; binds the decision to the arguments. */
  argsHash: string;
  signedAt: string;
}

/**
 * What the biometric-gated approval key signs to approve or deny.
 *
 * `windowSec` is inside the message on purpose. If the duration rode alongside
 * the signature, anything that could rewrite the request between this phone
 * and the server could turn five minutes of access into eight hours without
 * invalidating a thing. `once` signs a literal `0` rather than dropping the
 * line, so the message is always these seven fields in this order — one shape,
 * one way to build it, on both sides.
 *
 * `v2` marks the extra line: the server rebuilds v2 and only v2, so a phone
 * still signing the old six-line message is refused rather than silently given
 * whatever window the server felt like.
 */
export function decisionMessage(input: DecisionMessageInput): string {
  return [
    'agentaction.decision.v2',
    input.requestId,
    input.decision,
    input.scope,
    String(input.windowSec),
    input.argsHash,
    input.signedAt,
  ].join('\n');
}

/** Unix seconds, as a string, for the `x-aa-timestamp` header. */
export function requestTimestamp(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}

/**
 * The `signedAt` a decision carries: unix seconds, as a string.
 *
 * The server validates it against /^\d{1,12}$/ and measures the clock skew
 * from it, so ISO-8601 here is rejected outright — and because the signature
 * covers this exact string, the format is part of the wire contract rather
 * than a display choice.
 */
export function decisionSignedAt(nowMs: number = Date.now()): string {
  return String(Math.floor(nowMs / 1000));
}
