export interface Config {
  env: string;
  port: number;
  logLevel: string;
  /** Where phones reach this server. It is baked into the pairing QR payload,
   *  so a wrong value here pairs phones that can never call home. */
  publicBaseUrl: string;
  pairingTtlSec: number;
  signatureSkewSec: number;
  expoAccessToken: string | undefined;
  /** Explicit opt-out. Push is on by default; tests and local dev set this. */
  pushDisabled: boolean;
  /** Bounds a tenant may not cross, so a bad value cannot disable approval. */
  minRequestTtlSec: number;
  maxRequestTtlSec: number;
  maxDeviceCap: number;
  /** How long a "allow for a while" grant lasts. */
  grantWindowSec: number;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export const config: Config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4890),
  logLevel: process.env.LOG_LEVEL || 'info',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'http://localhost:4890',
  pairingTtlSec: int(process.env.PAIRING_TTL_SEC, 300),
  signatureSkewSec: int(process.env.SIGNATURE_SKEW_SEC, 120),
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN || undefined,
  pushDisabled: (process.env.EXPO_PUSH_DISABLED || '').toLowerCase() === 'true',
  minRequestTtlSec: 300,
  maxRequestTtlSec: 3600,
  maxDeviceCap: 5,
  grantWindowSec: int(process.env.GRANT_WINDOW_SEC, 900),
};
