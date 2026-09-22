/**
 * How long an approval lasts, in the words the owner reads.
 *
 * The durations themselves are the wire contract (`DECISION_WINDOWS_SEC` in
 * protocol.ts); this file is the presentation layer over them, and the one
 * place that decides which of them a given account may actually be offered.
 * It is pure so the rule can be tested without a screen.
 */
import { DECISION_WINDOWS_SEC } from './protocol';
import type { DecisionWindowSec } from './protocol';

export interface WindowOption {
  sec: number;
  /** For a chip: as short as it can be and still be unambiguous. */
  label: string;
  /** For a sentence: "…allowed for 15 minutes." */
  phrase: string;
}

/**
 * Keyed by the protocol's own union, so a duration added to the wire contract
 * without a label is a type error here rather than a blank chip on a phone.
 */
const WORDS: Record<DecisionWindowSec, { label: string; phrase: string }> = {
  300: { label: '5 min', phrase: '5 minutes' },
  900: { label: '15 min', phrase: '15 minutes' },
  3600: { label: '1 hour', phrase: '1 hour' },
  28800: { label: '8 hours', phrase: '8 hours' },
};

const OPTIONS: readonly WindowOption[] = DECISION_WINDOWS_SEC.map(sec => ({
  sec,
  ...WORDS[sec],
}));

/**
 * The windows this account may be offered, shortest first.
 *
 * `maxWindowSec` is the agency's ceiling, sent with the request. Anything
 * above it is left out rather than shown and then refused — an agency that
 * caps its customers at five minutes should never see a phone promise an hour.
 *
 * A missing ceiling offers nothing. That is the fail-closed direction: an
 * older server that does not send the field costs the owner a convenience,
 * where assuming a default would hand them a window their agency never agreed
 * to.
 */
export function windowOptionsFor(maxWindowSec: number | null | undefined): WindowOption[] {
  if (typeof maxWindowSec !== 'number' || !Number.isFinite(maxWindowSec)) return [];
  return OPTIONS.filter(option => option.sec <= maxWindowSec);
}

/** "15 minutes" for the outcome line. Falls back to minutes if the set grows. */
export function describeWindow(sec: number): string {
  const known = OPTIONS.find(option => option.sec === sec);
  if (known) return known.phrase;
  const minutes = Math.max(1, Math.round(sec / 60));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}
