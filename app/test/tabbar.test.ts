/**
 * The tab bar and the system gesture bar.
 *
 * This suite exists because of a total failure, not a cosmetic one: on a
 * Samsung Z Fold6 the tabs were drawn inside the 48px the system reserves at
 * the bottom of the screen, where a tap never reaches them, and the app could
 * not be navigated at all.
 *
 * The rule is one line: the bar's touch targets end where the inset begins.
 */
import { BAR_HEIGHT, tabBarLayout } from '../components/TabBar';

/** A Z Fold6 unfolded: tall status bar, 48px gesture bar. */
const FOLDABLE = { bottom: 48, left: 0, right: 0 };
/** An older Android phone with hardware keys and no insets at all. */
const FLAT = { bottom: 0, left: 0, right: 0 };
/** A notched phone rotated, or a display cutout reported sideways. */
const SIDEWAYS = { bottom: 21, left: 44, right: 44 };

describe('tabBarLayout', () => {
  it('adds the bottom inset as dead space, not as touch target', () => {
    const layout = tabBarLayout(FOLDABLE);
    expect(layout.height).toBe(BAR_HEIGHT + 48);
    expect(layout.paddingBottom).toBe(48);
    expect(layout.tabHeight).toBe(BAR_HEIGHT);

    // The whole point: a tab fits in the live area above the inset.
    const live = layout.height - layout.paddingBottom;
    expect(layout.tabHeight).toBeLessThanOrEqual(live);
  });

  it('leaves the touch target comfortably above the minimum on every device', () => {
    for (const insets of [FOLDABLE, FLAT, SIDEWAYS]) {
      // 44pt is the smallest target either platform's guidance allows.
      expect(tabBarLayout(insets).tabHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('reserves nothing a device has not asked for', () => {
    const layout = tabBarLayout(FLAT);
    expect(layout.height).toBe(BAR_HEIGHT);
    expect(layout.paddingBottom).toBe(0);
    expect(layout.paddingLeft).toBe(0);
    expect(layout.paddingRight).toBe(0);
  });

  it('pads the sides for a cutout or a case', () => {
    const layout = tabBarLayout(SIDEWAYS);
    expect(layout.paddingLeft).toBe(44);
    expect(layout.paddingRight).toBe(44);
    expect(layout.height).toBe(BAR_HEIGHT + 21);
  });

  it('ignores a negative inset rather than eating the bar', () => {
    // Nothing should report one, but a negative height is an invisible bar,
    // which is the same failure this suite exists to prevent.
    const layout = tabBarLayout({ bottom: -40, left: -10, right: -10 });
    expect(layout.height).toBe(BAR_HEIGHT);
    expect(layout.paddingBottom).toBe(0);
    expect(layout.paddingLeft).toBe(0);
    expect(layout.paddingRight).toBe(0);
  });
});
