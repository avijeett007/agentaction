/**
 * The bottom tab bar.
 *
 * The important part of this file is the padding. A Samsung Z Fold6 reserves
 * roughly 48px at the bottom of the screen for the system gesture bar, and
 * anything drawn there is simply not tappable — which is how the old bar
 * became unusable. So the bar is `BAR_HEIGHT` of touchable area *plus* the
 * reported inset as dead padding beneath it. Nothing interactive is ever
 * inside the inset.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { palette, radius, space } from '../lib/theme';
import type { IconName } from './ui';

/** Touchable height, before the system inset is added underneath. */
export const BAR_HEIGHT = 60;

export type TabKey = 'pending' | 'accounts';

export interface Insets {
  bottom: number;
  left: number;
  right: number;
}

export interface TabBarLayout {
  /** Total height of the bar, inset included. */
  height: number;
  /** Dead space at the bottom. Nothing interactive may be drawn in it. */
  paddingBottom: number;
  paddingLeft: number;
  paddingRight: number;
  /** Height of each tab's touch target, which must fit above the inset. */
  tabHeight: number;
}

/**
 * Where the bar ends and the system's territory begins.
 *
 * Kept as a function, and tested, because getting it wrong once already made
 * the app unnavigable on a foldable: the tabs were drawn inside the 48px the
 * OS reserves for the gesture bar, where a tap never reaches them.
 */
export function tabBarLayout(insets: Insets): TabBarLayout {
  const bottom = Math.max(0, insets.bottom);
  return {
    height: BAR_HEIGHT + bottom,
    paddingBottom: bottom,
    paddingLeft: Math.max(0, insets.left),
    paddingRight: Math.max(0, insets.right),
    tabHeight: BAR_HEIGHT,
  };
}

export function TabBar({
  tab,
  onSelect,
  waitingCount,
}: {
  tab: TabKey;
  onSelect: (next: TabKey) => void;
  waitingCount: number;
}) {
  const layout = tabBarLayout(useSafeAreaInsets());
  return (
    <View
      style={[
        styles.bar,
        {
          height: layout.height,
          paddingBottom: layout.paddingBottom,
          paddingLeft: layout.paddingLeft,
          paddingRight: layout.paddingRight,
        },
      ]}
    >
      <TabItem
        label="Waiting"
        icon="shield-checkmark"
        iconIdle="shield-checkmark-outline"
        selected={tab === 'pending'}
        badge={waitingCount}
        onPress={() => onSelect('pending')}
      />
      <TabItem
        label="Accounts"
        icon="phone-portrait"
        iconIdle="phone-portrait-outline"
        selected={tab === 'accounts'}
        onPress={() => onSelect('accounts')}
      />
    </View>
  );
}

function TabItem({
  label,
  icon,
  iconIdle,
  selected,
  badge = 0,
  onPress,
}: {
  label: string;
  icon: IconName;
  iconIdle: IconName;
  selected: boolean;
  badge?: number;
  onPress: () => void;
}) {
  const colour = selected ? palette.brand : palette.muted;
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{ selected }}
      accessibilityLabel={badge > 0 ? `${label}, ${badge} waiting` : label}
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed ? styles.itemPressed : null]}
    >
      <View style={styles.iconSlot}>
        <View style={[styles.iconPill, selected ? styles.iconPillSelected : null]}>
          <Ionicons name={selected ? icon : iconIdle} size={21} color={colour} />
        </View>
        {badge > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} allowFontScaling={false}>
              {badge > 99 ? '99+' : badge}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.label, { color: colour }, selected ? styles.labelSelected : null]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: palette.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
  },
  item: {
    flex: 1,
    // Height comes from the bar, so the touch target fills the bar's live
    // area exactly — top edge to the start of the inset.
    height: BAR_HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
  },
  itemPressed: { backgroundColor: palette.pressDeep },
  iconSlot: { position: 'relative' },
  iconPill: {
    paddingHorizontal: space.lg,
    paddingVertical: 3,
    borderRadius: radius.pill,
  },
  iconPillSelected: { backgroundColor: palette.brandWash },
  badge: {
    position: 'absolute',
    top: -5,
    right: 4,
    minWidth: 18,
    height: 18,
    borderRadius: radius.pill,
    paddingHorizontal: 5,
    alignItems: 'center',
    justifyContent: 'center',
    // Amber, not red: something is waiting on the owner, which is the normal
    // working state of this app, not a fault.
    backgroundColor: palette.hold,
  },
  badgeText: { fontSize: 11, fontWeight: '800', color: palette.ink, lineHeight: 14 },
  label: { fontSize: 11, fontWeight: '600', letterSpacing: 0.1 },
  labelSelected: { fontWeight: '700' },
});
