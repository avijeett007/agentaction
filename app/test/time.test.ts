/** The expiry countdown shown on every pending request. */
import { byNewestFirst, countdownFor, formatCountdown, isExpired, msUntil } from '../lib/time';

describe('formatCountdown', () => {
  it('says "expired" at and past zero', () => {
    expect(formatCountdown(0)).toBe('expired');
    expect(formatCountdown(-1)).toBe('expired');
    expect(formatCountdown(-60_000)).toBe('expired');
  });

  it('shows bare seconds under a minute', () => {
    expect(formatCountdown(1)).toBe('0s');
    expect(formatCountdown(999)).toBe('0s');
    expect(formatCountdown(1_000)).toBe('1s');
    expect(formatCountdown(42_400)).toBe('42s');
    expect(formatCountdown(59_999)).toBe('59s');
  });

  it('pads the seconds once minutes appear, so the text stops jittering', () => {
    expect(formatCountdown(60_000)).toBe('1m 00s');
    expect(formatCountdown(65_000)).toBe('1m 05s');
    expect(formatCountdown(245_000)).toBe('4m 05s');
    expect(formatCountdown(599_000)).toBe('9m 59s');
    expect(formatCountdown(3_599_000)).toBe('59m 59s');
  });

  it('switches to hours and minutes past an hour', () => {
    expect(formatCountdown(3_600_000)).toBe('1h 00m');
    expect(formatCountdown(3_720_000)).toBe('1h 02m');
    expect(formatCountdown(7_380_000)).toBe('2h 03m');
  });

  it('treats a nonsense duration as expired rather than printing NaN', () => {
    expect(formatCountdown(Number.NaN)).toBe('expired');
    expect(formatCountdown(Number.POSITIVE_INFINITY)).toBe('expired');
  });
});

describe('msUntil and isExpired', () => {
  const now = Date.parse('2026-09-20T12:00:00.000Z');

  it('measures from the given instant', () => {
    expect(msUntil('2026-09-20T12:10:00.000Z', now)).toBe(600_000);
    expect(msUntil('2026-09-20T11:55:00.000Z', now)).toBe(-300_000);
  });

  it('treats an unparseable expiry as already expired', () => {
    // Better to refuse a decision than to offer one on a request whose window
    // we cannot read.
    expect(msUntil('sometime next week', now)).toBe(0);
    expect(isExpired('sometime next week', now)).toBe(true);
  });

  it('is expired exactly at the boundary', () => {
    expect(isExpired('2026-09-20T12:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-09-20T12:00:00.001Z', now)).toBe(false);
  });
});

describe('countdownFor', () => {
  it('formats the remaining time of an ISO expiry', () => {
    const now = Date.parse('2026-09-20T12:00:00.000Z');
    expect(countdownFor('2026-09-20T12:09:30.000Z', now)).toBe('9m 30s');
    expect(countdownFor('2026-09-20T11:59:00.000Z', now)).toBe('expired');
  });
});

describe('byNewestFirst', () => {
  it('sorts the pending list newest first', () => {
    const items = [
      { createdAt: '2026-09-20T10:00:00.000Z' },
      { createdAt: '2026-09-20T12:00:00.000Z' },
      { createdAt: '2026-09-20T11:00:00.000Z' },
    ];
    expect([...items].sort(byNewestFirst).map(i => i.createdAt)).toEqual([
      '2026-09-20T12:00:00.000Z',
      '2026-09-20T11:00:00.000Z',
      '2026-09-20T10:00:00.000Z',
    ]);
  });
});
