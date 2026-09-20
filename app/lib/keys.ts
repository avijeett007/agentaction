/**
 * The two Ed25519 keys a paired phone holds.
 *
 * - **device key** — signs every API call. No prompt: the phone polls in the
 *   background and nobody wants Face ID to open a list.
 * - **approval key** — signs a decision. Reading it must cost a biometric,
 *   because possession of this key *is* the approval.
 *
 * Private halves never leave `expo-secure-store` (the iOS keychain /
 * Android keystore). Signing happens in JavaScript, so the raw key is briefly
 * in memory; moving the signature into the secure element needs a native
 * module and is a recorded Phase 2 hardening item.
 */
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import * as Crypto from 'expo-crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromBase64Url, toBase64Url, utf8 } from './protocol';

// @noble/ed25519 v3 ships no hash of its own so it stays dependency-free.
// React Native has no WebCrypto, so wire in the pure-JS SHA-512 once, here,
// where every signing path goes through.
ed.hashes.sha512 = sha512;

/**
 * How the approval key ended up being protected on this device.
 *
 * - `keychain` — stored with `requireAuthentication`, so the OS itself refuses
 *   to hand the key over without Face ID / fingerprint. This is what we want.
 * - `app-gated` — the platform refused that (typically: nothing enrolled when
 *   the key was created, or an Android keystore that rejects the access
 *   control). The key is stored normally and *we* prompt before reading it.
 *   Weaker — an attacker with the unlocked phone and a debugger could read it
 *   — but it is the only way the owner can still approve anything.
 */
export type ApprovalKeyMode = 'keychain' | 'app-gated';

export interface KeyPairRefs {
  /** Local handle for this account's keys. Chosen before the server issues a
   *  device id, so a half-finished pairing never collides with a live one. */
  keyRef: string;
  devicePubKey: string;
  approvalPubKey: string;
  approvalKeyMode: ApprovalKeyMode;
}

export class BiometricRefusedError extends Error {
  constructor(public reason: string) {
    super('Biometric confirmation was not completed');
    this.name = 'BiometricRefusedError';
  }
}

const APPROVAL_PROMPT = 'Confirm it is you';

const deviceKeyName = (keyRef: string) => `aa.dk.${keyRef}`;
const approvalKeyName = (keyRef: string) => `aa.ak.${keyRef}`;

function randomKeyRef(): string {
  const bytes = Crypto.getRandomBytes(12);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

/** A 32-byte Ed25519 seed from the platform CSPRNG. */
function newSecretKey(): Uint8Array {
  return Uint8Array.from(Crypto.getRandomBytes(32));
}

export function publicKeyFor(secretKeyB64: string): string {
  return toBase64Url(ed.getPublicKey(fromBase64Url(secretKeyB64)));
}

/** What the phone can currently do to prove the owner is present. */
export interface BiometricStatus {
  hasHardware: boolean;
  isEnrolled: boolean;
  level: LocalAuthentication.SecurityLevel;
  /** False means the phone has no lock at all — nothing to prompt with. */
  canPrompt: boolean;
  types: LocalAuthentication.AuthenticationType[];
}

export async function getBiometricStatus(): Promise<BiometricStatus> {
  const [hasHardware, isEnrolled, level, types] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
    LocalAuthentication.getEnrolledLevelAsync(),
    LocalAuthentication.supportedAuthenticationTypesAsync(),
  ]);
  return {
    hasHardware,
    isEnrolled,
    level,
    types,
    canPrompt: level !== LocalAuthentication.SecurityLevel.NONE,
  };
}

/**
 * Prompt the owner. Returns quietly when the phone has no lock configured at
 * all — the alternative is an owner who can never approve anything, which the
 * design explicitly rules out. Any *refusal* (cancel, failed match, lockout)
 * throws, because a cancel must never turn into an approval.
 */
export async function promptOwner(promptMessage = APPROVAL_PROMPT): Promise<'verified' | 'unprotected'> {
  const status = await getBiometricStatus();
  if (!status.canPrompt) return 'unprotected';

  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    // Let the OS fall back to the device passcode: the owner may have a
    // bandaged thumb, and the passcode is still proof of possession.
    disableDeviceFallback: false,
    cancelLabel: 'Cancel',
  });
  if (result.success) return 'verified';
  throw new BiometricRefusedError(result.error);
}

/**
 * Generate and persist both keypairs. Call before registering with the server;
 * the returned public keys are what gets registered.
 */
export async function createKeys(): Promise<KeyPairRefs> {
  const keyRef = randomKeyRef();
  const deviceSecret = newSecretKey();
  const approvalSecret = newSecretKey();

  const deviceSecretB64 = toBase64Url(deviceSecret);
  const approvalSecretB64 = toBase64Url(approvalSecret);

  await SecureStore.setItemAsync(deviceKeyName(keyRef), deviceSecretB64, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

  const approvalKeyMode = await storeApprovalKey(keyRef, approvalSecretB64);

  return {
    keyRef,
    devicePubKey: toBase64Url(ed.getPublicKey(deviceSecret)),
    approvalPubKey: toBase64Url(ed.getPublicKey(approvalSecret)),
    approvalKeyMode,
  };
}

/**
 * Store the approval key as tightly as the platform allows, and report which
 * of the two protections we actually got.
 */
async function storeApprovalKey(keyRef: string, secretB64: string): Promise<ApprovalKeyMode> {
  const name = approvalKeyName(keyRef);

  // `canUseBiometricAuthentication()` is the platform's own answer to "would a
  // requireAuthentication write succeed right now"; the try/catch covers the
  // devices where it says yes and then throws anyway.
  if (SecureStore.canUseBiometricAuthentication()) {
    try {
      await SecureStore.setItemAsync(name, secretB64, {
        requireAuthentication: true,
        authenticationPrompt: APPROVAL_PROMPT,
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      return 'keychain';
    } catch {
      // Fall through and store it app-gated rather than leave the owner unable
      // to pair at all.
      await SecureStore.deleteItemAsync(name).catch(() => undefined);
    }
  }

  await SecureStore.setItemAsync(name, secretB64, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return 'app-gated';
}

async function readKey(name: string, options?: SecureStore.SecureStoreOptions): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(name, options);
  if (!stored) throw new Error(`Key ${name} is missing from this device`);
  return fromBase64Url(stored);
}

/** Signs an API call. Never prompts. Returns a base64url Ed25519 signature. */
export async function signWithDeviceKey(keyRef: string, message: string): Promise<string> {
  const secret = await readKey(deviceKeyName(keyRef));
  return toBase64Url(ed.sign(utf8(message), secret));
}

/**
 * Signs a decision. Always costs the owner a biometric (or the device
 * passcode); on a phone with no lock at all it proceeds, and the caller is
 * told so it can keep saying that out loud in the UI.
 */
export async function signWithApprovalKey(
  keyRef: string,
  message: string,
  mode: ApprovalKeyMode,
  promptMessage = APPROVAL_PROMPT,
): Promise<{ signature: string; protection: 'verified' | 'unprotected' }> {
  if (mode === 'keychain') {
    // The OS prompts as part of the read; a refusal surfaces as a throw or a
    // null value, both of which stop us short of a signature.
    const secret = await readKey(approvalKeyName(keyRef), {
      requireAuthentication: true,
      authenticationPrompt: promptMessage,
    });
    return { signature: toBase64Url(ed.sign(utf8(message), secret)), protection: 'verified' };
  }

  const protection = await promptOwner(promptMessage);
  const secret = await readKey(approvalKeyName(keyRef));
  return { signature: toBase64Url(ed.sign(utf8(message), secret)), protection };
}

export async function deleteKeys(keyRef: string): Promise<void> {
  // Best effort: an unpair must finish even if one delete fails, or the
  // account sticks around forever.
  await Promise.all([
    SecureStore.deleteItemAsync(deviceKeyName(keyRef)).catch(() => undefined),
    SecureStore.deleteItemAsync(approvalKeyName(keyRef)).catch(() => undefined),
  ]);
}

/** Exposed for tests and for the "keys are still here" check on Settings. */
export const __keyNames = { deviceKeyName, approvalKeyName };
