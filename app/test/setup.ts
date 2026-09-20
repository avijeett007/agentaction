/**
 * Every expo-* module the app touches, replaced with an in-memory fake.
 *
 * Each fake exposes a `__test` handle so a test can say "this phone has no
 * biometrics" or "the keychain refuses requireAuthentication" without patching
 * internals. Nothing here reaches a device, a keychain or the network.
 */

jest.mock('expo-crypto', () => {
  // A counter-seeded PRNG: every call returns different bytes (so two
  // keypairs never collide) while a run stays reproducible.
  let counter = 1;
  const getRandomBytes = (byteCount: number) => {
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i += 1) {
      counter = (counter * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (counter >>> 16) & 0xff;
    }
    return out;
  };
  return {
    getRandomBytes,
    getRandomBytesAsync: async (n: number) => getRandomBytes(n),
    __test: { reset: () => { counter = 1; } },
  };
});

jest.mock('expo-secure-store', () => {
  // Types are inlined rather than declared: babel's jest.mock hoisting treats
  // a named type in this factory as an out-of-scope reference and refuses it.
  const state = {
    items: new Map<string, { value: string; requireAuthentication: boolean }>(),
    /** What the platform answers for "could I store a gated key?" */
    canUseBiometric: true,
    /** Simulates a platform that says yes then throws on the write. */
    refuseRequireAuthentication: false,
    /** Simulates the owner failing/cancelling the OS read prompt. */
    denyAuthenticatedReads: false,
    reset() {
      state.items.clear();
      state.canUseBiometric = true;
      state.refuseRequireAuthentication = false;
      state.denyAuthenticatedReads = false;
    },
  };

  return {
    WHEN_UNLOCKED: 'whenUnlocked',
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
    AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
    canUseBiometricAuthentication: jest.fn(() => state.canUseBiometric),
    isAvailableAsync: jest.fn(async () => true),
    setItemAsync: jest.fn(async (key: string, value: string, options?: { requireAuthentication?: boolean }) => {
      if (options?.requireAuthentication && state.refuseRequireAuthentication) {
        throw new Error('Could not encrypt the value with an authentication-gated key');
      }
      state.items.set(key, { value, requireAuthentication: Boolean(options?.requireAuthentication) });
    }),
    getItemAsync: jest.fn(async (key: string, options?: { requireAuthentication?: boolean }) => {
      const entry = state.items.get(key);
      if (!entry) return null;
      if (entry.requireAuthentication && state.denyAuthenticatedReads) {
        throw new Error('User canceled the authentication');
      }
      return entry.value;
    }),
    deleteItemAsync: jest.fn(async (key: string) => {
      state.items.delete(key);
    }),
    __test: state,
  };
});

jest.mock('expo-local-authentication', () => {
  const SecurityLevel = { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 };
  const state = {
    hasHardware: true,
    isEnrolled: true,
    level: SecurityLevel.BIOMETRIC_STRONG,
    result: { success: true } as { success: boolean; error?: string },
    reset() {
      state.hasHardware = true;
      state.isEnrolled = true;
      state.level = SecurityLevel.BIOMETRIC_STRONG;
      state.result = { success: true };
    },
  };
  return {
    SecurityLevel,
    AuthenticationType: { FINGERPRINT: 1, FACIAL_RECOGNITION: 2, IRIS: 3 },
    hasHardwareAsync: jest.fn(async () => state.hasHardware),
    isEnrolledAsync: jest.fn(async () => state.isEnrolled),
    getEnrolledLevelAsync: jest.fn(async () => state.level),
    supportedAuthenticationTypesAsync: jest.fn(async () => [2]),
    authenticateAsync: jest.fn(async () => state.result),
    cancelAuthenticate: jest.fn(async () => undefined),
    __test: state,
  };
});

jest.mock('expo-device', () => ({
  deviceName: "Test's iPhone",
  modelName: 'iPhone Test',
  brand: 'Apple',
}));

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { expoConfig: { extra: { eas: { projectId: 'test-project-id' } } } },
}));

jest.mock('expo-notifications', () => ({
  AndroidImportance: { MAX: 5, HIGH: 4, DEFAULT: 3 },
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted' })),
  requestPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true, status: 'granted' })),
  getExpoPushTokenAsync: jest.fn(async () => ({ data: 'ExponentPushToken[test]', type: 'expo' })),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  scheduleNotificationAsync: jest.fn(async () => 'local-notification-id'),
}));

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (key: string) => store.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: jest.fn(async (key: string) => {
        store.delete(key);
      }),
      clear: jest.fn(async () => store.clear()),
    },
    __test: { store },
  };
});

// Nothing in these suites may touch the network: a stray fetch should fail
// loudly rather than quietly hit a real server.
beforeEach(() => {
  (globalThis as { fetch?: unknown }).fetch = jest.fn(() => {
    throw new Error('A test tried to make a real network call');
  });
});
