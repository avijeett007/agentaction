/**
 * Which durations the picker is allowed to show.
 *
 * The rule is one-directional and worth stating plainly: the phone may offer
 * less than the agency allows, never more. A window on this screen is a
 * promise — tap it and you are told the call will go through unasked until
 * then — so offering one the server would shorten or refuse is a lie told by
 * the product itself.
 */
import { DECISION_WINDOWS_SEC } from '../lib/protocol';
import { describeWindow, windowOptionsFor } from '../lib/windows';

describe('windowOptionsFor', () => {
  it('offers every window when the agency allows the longest one', () => {
    expect(windowOptionsFor(28800).map(o => o.sec)).toEqual([300, 900, 3600, 28800]);
  });

  it('offers only what the tenant allows', () => {
    // The default ceiling: an hour, so eight hours is not on the screen.
    expect(windowOptionsFor(3600).map(o => o.sec)).toEqual([300, 900, 3600]);
    // The bank: five minutes and nothing else.
    expect(windowOptionsFor(300).map(o => o.sec)).toEqual([300]);
  });

  it('offers nothing when the agency allows no window at all', () => {
    // The screen then shows Approve and Deny, and no third choice.
    expect(windowOptionsFor(0)).toEqual([]);
  });

  it('offers nothing when the ceiling is missing, rather than guessing one', () => {
    // An older server that does not send the field costs the owner a
    // convenience; assuming a default would hand them access their agency
    // never agreed to.
    expect(windowOptionsFor(undefined)).toEqual([]);
    expect(windowOptionsFor(null)).toEqual([]);
    expect(windowOptionsFor(Number.NaN)).toEqual([]);
  });

  it('includes a ceiling that falls between two windows, rounded down', () => {
    // A tenant is free to set any number of seconds; the picker shows the
    // windows that fit inside it and no more.
    expect(windowOptionsFor(1000).map(o => o.sec)).toEqual([300, 900]);
    expect(windowOptionsFor(299)).toEqual([]);
  });

  it('only ever offers durations the protocol allows', () => {
    // Anything else would be refused outright by the server.
    for (const option of windowOptionsFor(28800)) {
      expect(DECISION_WINDOWS_SEC).toContain(option.sec);
    }
  });

  it('labels each one for a chip and for a sentence', () => {
    expect(windowOptionsFor(28800)).toEqual([
      { sec: 300, label: '5 min', phrase: '5 minutes' },
      { sec: 900, label: '15 min', phrase: '15 minutes' },
      { sec: 3600, label: '1 hour', phrase: '1 hour' },
      { sec: 28800, label: '8 hours', phrase: '8 hours' },
    ]);
  });
});

describe('describeWindow', () => {
  it('names a known window the way the outcome line reads it', () => {
    expect(describeWindow(900)).toBe('15 minutes');
    expect(describeWindow(3600)).toBe('1 hour');
  });

  it('falls back to minutes for a length the server chose itself', () => {
    // A tenant ceiling that is not one of our windows: the server clamps to it
    // and this line still has to say something true.
    expect(describeWindow(120)).toBe('2 minutes');
    expect(describeWindow(60)).toBe('1 minute');
  });
});
