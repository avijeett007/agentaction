/**
 * Key generation, storage and signing.
 *
 * The round-trips verify with @noble against the *exported public key* — the
 * same key the server stores — so a passing test means the server would accept
 * the signature.
 */
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import * as SecureStore from 'expo-secure-store';
import * as LocalAuthentication from 'expo-local-authentication';
import {
  BiometricRefusedError,
  __keyNames,
  createKeys,
  deleteKeys,
  getBiometricStatus,
  promptOwner,
  signWithApprovalKey,
  signWithDeviceKey,
} from '../lib/keys';
import { fromBase64Url, utf8 } from '../lib/protocol';

ed.hashes.sha512 = sha512;

const secureStore = SecureStore as unknown as { __test: { reset(): void; items: Map<string, { value: string; requireAuthentication: boolean }>; canUseBiometric: boolean; refuseRequireAuthentication: boolean; denyAuthenticatedReads: boolean } };
const localAuth = LocalAuthentication as unknown as {
  __test: { reset(): void; hasHardware: boolean; isEnrolled: boolean; level: number; result: { success: boolean; error?: string } };
};

function verify(signatureB64: string, message: string, publicKeyB64: string): boolean {
  return ed.verify(fromBase64Url(signatureB64), utf8(message), fromBase64Url(publicKeyB64));
}

beforeEach(() => {
  secureStore.__test.reset();
  localAuth.__test.reset();
});

describe('createKeys', () => {
  it('produces two distinct raw 32-byte Ed25519 public keys', async () => {
    const keys = await createKeys();

    expect(fromBase64Url(keys.devicePubKey)).toHaveLength(32);
    expect(fromBase64Url(keys.approvalPubKey)).toHaveLength(32);
    expect(keys.devicePubKey).not.toBe(keys.approvalPubKey);
    // base64url, no padding — what the server's fromBase64url() expects.
    expect(keys.devicePubKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('stores the device key plainly and the approval key behind the keychain', async () => {
    const keys = await createKeys();

    const deviceEntry = secureStore.__test.items.get(__keyNames.deviceKeyName(keys.keyRef));
    const approvalEntry = secureStore.__test.items.get(__keyNames.approvalKeyName(keys.keyRef));

    expect(deviceEntry?.requireAuthentication).toBe(false);
    expect(approvalEntry?.requireAuthentication).toBe(true);
    expect(keys.approvalKeyMode).toBe('keychain');
  });

  it('gives each pairing its own key handle', async () => {
    const first = await createKeys();
    const second = await createKeys();
    expect(first.keyRef).not.toBe(second.keyRef);
    expect(secureStore.__test.items.size).toBe(4);
  });
});

describe('signWithDeviceKey', () => {
  it('produces a signature the registered public key verifies', async () => {
    const keys = await createKeys();
    const message = 'GET\n/v1/device/requests\n1789862400\nabc';

    const signature = await signWithDeviceKey(keys.keyRef, message);

    expect(fromBase64Url(signature)).toHaveLength(64);
    expect(verify(signature, message, keys.devicePubKey)).toBe(true);
  });

  it('does not verify against the approval key, or against a changed message', async () => {
    const keys = await createKeys();
    const signature = await signWithDeviceKey(keys.keyRef, 'one');

    expect(verify(signature, 'one', keys.approvalPubKey)).toBe(false);
    expect(verify(signature, 'two', keys.devicePubKey)).toBe(false);
  });

  it('never prompts — the app polls in the background', async () => {
    const keys = await createKeys();
    await signWithDeviceKey(keys.keyRef, 'hello');
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  });

  it('fails loudly when the key is gone from the keychain', async () => {
    const keys = await createKeys();
    await deleteKeys(keys.keyRef);
    await expect(signWithDeviceKey(keys.keyRef, 'hello')).rejects.toThrow(/missing/);
  });
});

describe('signWithApprovalKey, keychain mode', () => {
  it('reads the key through the OS prompt and verifies against the approval key', async () => {
    const keys = await createKeys();
    const message =
      'agentaction.decision.v2\nreq_1\napproved\nonce\n0\nhash\n2026-09-20T00:00:00.000Z';

    const { signature, protection } = await signWithApprovalKey(keys.keyRef, message, 'keychain');

    expect(verify(signature, message, keys.approvalPubKey)).toBe(true);
    expect(verify(signature, message, keys.devicePubKey)).toBe(false);
    expect(protection).toBe('verified');
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(
      __keyNames.approvalKeyName(keys.keyRef),
      expect.objectContaining({ requireAuthentication: true }),
    );
  });

  it('produces no signature when the owner refuses the OS prompt', async () => {
    const keys = await createKeys();
    secureStore.__test.denyAuthenticatedReads = true;

    await expect(signWithApprovalKey(keys.keyRef, 'msg', 'keychain')).rejects.toThrow(
      /canceled the authentication/,
    );
  });
});

describe('when the platform will not gate the key itself', () => {
  it('falls back to app-gated storage when the platform says it cannot', async () => {
    secureStore.__test.canUseBiometric = false;

    const keys = await createKeys();

    expect(keys.approvalKeyMode).toBe('app-gated');
    expect(
      secureStore.__test.items.get(__keyNames.approvalKeyName(keys.keyRef))?.requireAuthentication,
    ).toBe(false);
  });

  it('falls back when the platform says yes and then throws on the write', async () => {
    secureStore.__test.refuseRequireAuthentication = true;

    const keys = await createKeys();

    expect(keys.approvalKeyMode).toBe('app-gated');
    // The key must still be usable: the owner must never be locked out.
    const { signature } = await signWithApprovalKey(keys.keyRef, 'msg', keys.approvalKeyMode);
    expect(verify(signature, 'msg', keys.approvalPubKey)).toBe(true);
  });

  it('prompts through expo-local-authentication before it reads the key', async () => {
    secureStore.__test.canUseBiometric = false;
    const keys = await createKeys();

    const { protection } = await signWithApprovalKey(keys.keyRef, 'msg', 'app-gated');

    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
    expect(protection).toBe('verified');
  });

  it('refuses to sign when the owner cancels that prompt', async () => {
    secureStore.__test.canUseBiometric = false;
    const keys = await createKeys();
    localAuth.__test.result = { success: false, error: 'user_cancel' };

    await expect(signWithApprovalKey(keys.keyRef, 'msg', 'app-gated')).rejects.toBeInstanceOf(
      BiometricRefusedError,
    );
  });

  it('still signs on a phone with no lock at all, and says the approval was unprotected', async () => {
    // The design is explicit: biometrics when available, but the owner must
    // never end up unable to approve anything.
    secureStore.__test.canUseBiometric = false;
    const keys = await createKeys();
    localAuth.__test.hasHardware = false;
    localAuth.__test.isEnrolled = false;
    localAuth.__test.level = 0;

    const { signature, protection } = await signWithApprovalKey(keys.keyRef, 'msg', 'app-gated');

    expect(verify(signature, 'msg', keys.approvalPubKey)).toBe(true);
    expect(protection).toBe('unprotected');
    expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  });
});

describe('getBiometricStatus and promptOwner', () => {
  it('reports what the phone can do', async () => {
    const status = await getBiometricStatus();
    expect(status).toMatchObject({ hasHardware: true, isEnrolled: true, canPrompt: true });
  });

  it('reports a phone with no enrolled lock as unable to prompt', async () => {
    localAuth.__test.level = 0;
    expect((await getBiometricStatus()).canPrompt).toBe(false);
    await expect(promptOwner()).resolves.toBe('unprotected');
  });

  it('throws the reason when the owner does not confirm', async () => {
    localAuth.__test.result = { success: false, error: 'lockout' };
    await expect(promptOwner()).rejects.toMatchObject({ reason: 'lockout' });
  });
});

describe('deleteKeys', () => {
  it('removes both halves', async () => {
    const keys = await createKeys();
    await deleteKeys(keys.keyRef);
    expect(secureStore.__test.items.size).toBe(0);
  });
});
