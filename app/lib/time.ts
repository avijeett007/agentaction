/**
 * Expiry countdowns. An approval request is short-lived — ten minutes by
 * default — so the remaining time is the most important number on the screen.
 */

export function msUntil(expiresAt: string, nowMs: number = Date.now()): number {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return 0;
  return at - nowMs;
}

export function isExpired(expiresAt: string, nowMs: number = Date.now()): boolean {
  return msUntil(expiresAt, nowMs) <= 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * "expired" · "42s" · "4m 05s" · "1h 02m".
 *
 * Seconds are padded once minutes appear so the text stops jittering in width
 * while it ticks down.
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${pad(totalSeconds % 60)}s`;

  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h ${pad(totalMinutes % 60)}m`;
}

export function countdownFor(expiresAt: string, nowMs: number = Date.now()): string {
  return formatCountdown(msUntil(expiresAt, nowMs));
}

/** Newest first — the ordering the pending list uses. */
export function byNewestFirst(a: { createdAt: string }, b: { createdAt: string }): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt);
}
