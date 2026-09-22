/**
 * The whole visual vocabulary of the app, in one file.
 *
 * Everything here obeys three rules. Nothing interactive may sit inside a
 * system inset, because on a foldable the gesture bar swallows the bottom
 * 48px. Every touchable shows it was touched, because a decision the owner is
 * not sure landed is a decision they will make twice. And nothing animates
 * except the countdown, because this screen is read under time pressure and
 * movement that is not information is noise.
 */
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { RefreshControlProps, StyleProp, ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Theme } from '../lib/theme';
import { palette, radius, space, type } from '../lib/theme';
import { Lockup } from './brand';

export type IconName = keyof typeof Ionicons.glyphMap;

/**
 * The system insets, with the horizontal pair kept as well as the vertical.
 * A Z Fold6 reports a 48px bottom inset for the gesture bar; a notched phone
 * held in a case reports left and right. Both have to be padding, never a
 * place a button is allowed to be.
 */
export function useScreenInsets() {
  const insets = useSafeAreaInsets();
  return insets;
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Screen({
  children,
  scroll = true,
  refreshControl,
  footer,
}: {
  children: ReactNode;
  scroll?: boolean;
  refreshControl?: ReactElement<RefreshControlProps>;
  /** Pinned below the scroll area — the decision buttons live here. */
  footer?: ReactNode;
}) {
  const insets = useScreenInsets();
  const horizontal = {
    paddingLeft: space.xl + insets.left,
    paddingRight: space.xl + insets.right,
  };
  // When a footer is pinned it covers the inset, so the scroll only needs
  // clearance from the footer itself.
  const bottomPad = footer ? space.xl : space.xxl + insets.bottom;

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.screenContent, horizontal, { paddingBottom: bottomPad }]}
      refreshControl={refreshControl}
      indicatorStyle="white"
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, styles.screenContent, horizontal, { paddingBottom: bottomPad }]}>
      {children}
    </View>
  );

  if (!footer) return body;

  return (
    <View style={styles.flex}>
      {body}
      <View
        style={[
          styles.footer,
          horizontal,
          { paddingBottom: Math.max(insets.bottom, space.md) + space.sm },
        ]}
      >
        {footer}
      </View>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Headers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * App chrome. This is AgentAction speaking as itself — before any pairing, and
 * on the two tabbed screens, which are about the phone rather than about one
 * account.
 */
export function AppHeader({
  subtitle,
  descriptor,
  right,
  onBack,
}: {
  subtitle?: string;
  descriptor?: string;
  right?: ReactNode;
  onBack?: () => void;
}) {
  const insets = useScreenInsets();
  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + space.md,
          paddingLeft: (onBack ? space.lg : space.xl) + insets.left,
          paddingRight: space.xl + insets.right,
        },
      ]}
    >
      <View style={styles.headerTopRow}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            hitSlop={10}
            style={({ pressed }) => [styles.backButton, pressed ? styles.backButtonPressed : null]}
          >
            <Ionicons name="chevron-back" size={22} color={palette.text} />
          </Pressable>
        ) : null}
        <Lockup />
        {right ?? null}
      </View>
      {subtitle ? <Text style={styles.headerSlogan}>{subtitle}</Text> : null}
      {descriptor ? <Text style={styles.headerDescriptor}>{descriptor}</Text> : null}
    </View>
  );
}

/**
 * A screen that belongs to one account. The agency's colour tints the band and
 * draws the rail along its bottom edge, so the owner knows whose question this
 * is before they have read a word of it — without flooding a dark screen with
 * whatever colour that agency happened to pick.
 */
export function AccountHeader({
  theme,
  subtitle,
  onBack,
  right,
}: {
  theme: Theme;
  subtitle?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const insets = useScreenInsets();
  return (
    <View
      style={[
        styles.header,
        {
          paddingTop: insets.top + space.sm,
          paddingLeft: space.lg + insets.left,
          paddingRight: space.lg + insets.right,
        },
      ]}
    >
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.accent, opacity: 0.1 }]}
      />
      <View style={styles.headerTopRow}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            hitSlop={10}
            style={({ pressed }) => [styles.backButton, pressed ? styles.backButtonPressed : null]}
          >
            <Ionicons name="chevron-back" size={22} color={palette.text} />
          </Pressable>
        ) : null}
        {theme.brand.logoUrl ? (
          <Image
            source={{ uri: theme.brand.logoUrl }}
            style={styles.headerLogo}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        ) : (
          <View style={[styles.headerDot, { backgroundColor: theme.legible }]} />
        )}
        <View style={styles.flex}>
          <Text style={styles.headerBrand} numberOfLines={1}>
            {theme.brand.name}
          </Text>
          {subtitle ? (
            <Text style={styles.headerSubject} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        {right ?? null}
      </View>
      <View style={[styles.headerRail, { backgroundColor: theme.legible }]} />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Surfaces and text                                                           */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  style,
  tone,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A colour rail down the left edge — whose account this card belongs to. */
  tone?: string;
}) {
  return (
    <View style={[styles.card, style]}>
      {tone ? <View style={[styles.cardRail, { backgroundColor: tone }]} /> : null}
      {children}
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Heading({ children }: { children: ReactNode }) {
  return <Text style={type.heading}>{children}</Text>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

export type ButtonTone = 'primary' | 'secondary' | 'ghost' | 'deny';

export function Button({
  title,
  onPress,
  tone = 'secondary',
  theme,
  disabled,
  busy,
  icon,
  caption,
}: {
  title: string;
  onPress: () => void;
  tone?: ButtonTone;
  theme?: Theme;
  disabled?: boolean;
  busy?: boolean;
  icon?: IconName;
  /** One quiet line under the control, for an action that needs explaining. */
  caption?: string;
}) {
  // `legible`, not `accent`: a filled button in an agency's near-black brand
  // colour is an invisible button on this page.
  const accent = theme ? theme.legible : palette.brand;
  const fillText = theme ? theme.onLegible : '#FFFFFF';

  const filled = tone === 'primary';
  const background =
    filled ? accent
    : tone === 'deny' ? palette.denyWash
    : tone === 'ghost' ? 'transparent'
    : palette.raised;
  const colour =
    filled ? fillText
    : tone === 'deny' ? palette.deny
    : tone === 'ghost' ? palette.muted
    : palette.text;
  const borderColour =
    tone === 'deny' ? 'rgba(255,90,95,0.42)' : tone === 'ghost' ? 'transparent' : palette.line;

  const control = (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        filled ? styles.buttonPrimary : styles.buttonBordered,
        { backgroundColor: background, borderColor: filled ? 'transparent' : borderColour },
        disabled && !busy ? styles.buttonDisabled : null,
        pressed ? (filled ? styles.buttonPressedFilled : styles.buttonPressed) : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colour} />
      ) : (
        <View style={styles.buttonInner}>
          {icon ? <Ionicons name={icon} size={18} color={colour} /> : null}
          <Text style={[type.button, { color: colour }]} numberOfLines={1}>
            {title}
          </Text>
        </View>
      )}
    </Pressable>
  );

  if (!caption) return control;
  return (
    <View style={styles.buttonWithCaption}>
      {control}
      <Text style={styles.buttonCaption}>{caption}</Text>
    </View>
  );
}

/**
 * One choice among a few, sized for a thumb.
 *
 * A chip is the smallest thing in this app that commits to something, so it
 * carries the same 44pt target and the same pressed state as a full button —
 * the only difference is that several of them fit on a line, which is the
 * whole reason to reach for one.
 */
export function Chip({
  label,
  onPress,
  theme,
  disabled,
  busy,
  accessibilityLabel,
}: {
  label: string;
  onPress: () => void;
  theme?: Theme;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  const accent = theme ? theme.legible : palette.brand;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled || busy) }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        disabled && !busy ? styles.buttonDisabled : null,
        pressed ? styles.buttonPressed : null,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={accent} size="small" />
      ) : (
        <Text style={[styles.chipText, { color: accent }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A tappable list row: colour rail, stacked text, whatever sits on the right. */
export function Row({
  tone,
  title,
  subtitle,
  meta,
  right,
  chevron = true,
  onPress,
  accessibilityLabel,
}: {
  tone?: string;
  title: string;
  subtitle?: string;
  meta?: string;
  right?: ReactNode;
  chevron?: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? styles.rowPressed : null]}
    >
      {tone ? <View style={[styles.rowRail, { backgroundColor: tone }]} /> : null}
      <View style={styles.flex}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.rowSubtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        {meta ? (
          <Text style={styles.rowMeta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
      {right ?? null}
      {chevron ? <Ionicons name="chevron-forward" size={18} color={palette.muted} /> : null}
    </Pressable>
  );
}

export function LabelledInput({
  label,
  hint,
  ...input
}: {
  /** Omit when a card heading directly above already names the field. */
  label?: string;
  hint?: string;
} & React.ComponentProps<typeof TextInput>) {
  return (
    <View style={styles.inputGroup}>
      {label ? <Text style={styles.sectionLabel}>{label}</Text> : null}
      {hint ? <Text style={type.meta}>{hint}</Text> : null}
      <TextInput
        {...input}
        style={[styles.input, input.style]}
        placeholderTextColor={palette.muted}
        selectionColor={palette.brand}
      />
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

export type NoticeTone = 'info' | 'warn' | 'deny' | 'ok';

const NOTICE: Record<NoticeTone, { colour: string; wash: string; icon: IconName }> = {
  info: { colour: palette.brand, wash: palette.brandWash, icon: 'information-circle-outline' },
  warn: { colour: palette.hold, wash: palette.holdWash, icon: 'alert-circle-outline' },
  deny: { colour: palette.deny, wash: palette.denyWash, icon: 'close-circle-outline' },
  ok: { colour: palette.approve, wash: palette.approveWash, icon: 'checkmark-circle' },
};

/**
 * A short statement about state. The tone is carried by the rail and the icon;
 * the words stay in the normal text colour, because a paragraph set in amber
 * is harder to read than the thing it is warning about.
 */
export function Notice({ tone = 'info', children }: { tone?: NoticeTone; children: ReactNode }) {
  const { colour, wash, icon } = NOTICE[tone];
  return (
    <View style={[styles.notice, { backgroundColor: wash }]}>
      <View style={[styles.noticeRail, { backgroundColor: colour }]} />
      <Ionicons name={icon} size={17} color={colour} style={styles.noticeIcon} />
      <Text style={styles.noticeText}>{children}</Text>
    </View>
  );
}

function Pill({ label, colour }: { label: string; colour: string }) {
  return (
    <View style={[styles.pill, { borderColor: colour }]}>
      <Text style={[styles.pillText, { color: colour }]}>{label}</Text>
    </View>
  );
}

/** A named fact with a value — the shape of every diagnostics line. */
export function StatusLine({
  label,
  value,
  colour,
  icon,
}: {
  label: string;
  value: string;
  colour?: string;
  icon?: IconName;
}) {
  return (
    <View style={styles.statusLine}>
      <Text style={styles.statusLabel}>{label}</Text>
      <View style={styles.statusValueWrap}>
        {icon ? <Ionicons name={icon} size={15} color={colour ?? palette.text} /> : null}
        <Text style={[styles.statusValue, colour ? { color: colour } : null]} numberOfLines={2}>
          {value}
        </Text>
      </View>
    </View>
  );
}

/**
 * One argument the agent supplied.
 *
 * `Text` renders plain strings and nothing else — no markdown, no HTML — which
 * is the point: the value is attacker-influenced content written by a model,
 * and it must never be able to style or fake part of this screen.
 */
export function ArgumentField({
  label,
  value,
  sensitive,
  expanded,
  onToggle,
  first,
}: {
  label: string;
  value: string;
  sensitive?: boolean;
  expanded: boolean;
  onToggle: () => void;
  first?: boolean;
}) {
  const long = value.length > 180;
  const shown = long && !expanded ? `${value.slice(0, 180)}…` : value;
  return (
    <View style={[styles.field, first ? null : styles.fieldDivided]}>
      <View style={styles.fieldLabelRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        {sensitive ? <Pill label="sensitive" colour={palette.hold} /> : null}
      </View>
      <Text style={styles.fieldValue} selectable>
        {shown}
      </Text>
      {long ? (
        <Pressable
          onPress={onToggle}
          hitSlop={10}
          accessibilityRole="button"
          style={({ pressed }) => (pressed ? styles.fieldTogglePressed : null)}
        >
          <Text style={styles.fieldToggle}>{expanded ? 'Show less' : `Show all ${value.length} characters`}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <View style={styles.loading}>
      <ActivityIndicator color={palette.brand} />
      <Text style={styles.muted}>{label}</Text>
    </View>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card>
      <Notice tone="deny">{message}</Notice>
      {onRetry ? <Button title="Try again" icon="refresh" onPress={onRetry} /> : null}
    </Card>
  );
}

/**
 * An empty screen is an instruction, not a shrug: say what will appear here
 * and what the owner has to do to make it appear.
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  accent = palette.brand,
}: {
  icon: IconName;
  title: string;
  children: ReactNode;
  action?: ReactNode;
  accent?: string;
}) {
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { borderColor: accent }]}>
        <Ionicons name={icon} size={26} color={accent} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{children}</Text>
      {action ? <View style={styles.emptyAction}>{action}</View> : null}
    </View>
  );
}

/**
 * How much colour a countdown has earned.
 *
 * Quiet until the request is genuinely running out, then amber, then red: a
 * countdown that is red from the first second teaches the owner to ignore red.
 */
export function countdownColour(msLeft: number): string {
  if (msLeft <= 0) return palette.muted;
  if (msLeft < 60_000) return palette.deny;
  if (msLeft < 180_000) return palette.hold;
  return palette.text;
}

/** Re-renders on a timer so a countdown ticks without any animation code. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screenContent: { paddingTop: space.xl, gap: space.lg },

  footer: {
    paddingTop: space.lg,
    paddingBottom: space.md,
    gap: space.md,
    backgroundColor: palette.ink,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
  },

  header: {
    paddingBottom: space.lg,
    backgroundColor: palette.surface,
    gap: space.sm,
    overflow: 'hidden',
  },
  headerTopRow: { flexDirection: 'row', alignItems: 'center', gap: space.md, minHeight: 40 },
  headerSlogan: { fontSize: 14, fontWeight: '500', color: palette.muted, letterSpacing: -0.1 },
  headerDescriptor: { fontSize: 13, fontWeight: '400', color: palette.muted, opacity: 0.75 },
  headerRail: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 2 },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -space.sm,
  },
  backButtonPressed: { backgroundColor: palette.press },
  headerLogo: { width: 34, height: 34, borderRadius: 9, backgroundColor: palette.raised },
  headerDot: { width: 10, height: 34, borderRadius: 5 },
  headerBrand: { fontSize: 18, fontWeight: '700', color: palette.text, letterSpacing: -0.3 },
  headerSubject: { fontSize: 13, fontWeight: '500', color: palette.muted, marginTop: 1 },

  card: {
    backgroundColor: palette.surface,
    borderColor: palette.line,
    borderWidth: 1,
    borderRadius: radius.card,
    padding: space.lg,
    gap: space.md,
    overflow: 'hidden',
  },
  cardRail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  sectionLabel: { ...type.label },
  muted: { fontSize: 14, color: palette.muted, lineHeight: 21 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.line },

  button: {
    minHeight: 52,
    borderRadius: radius.control,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  buttonPrimary: { minHeight: 54 },
  buttonBordered: {},
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  buttonDisabled: { opacity: 0.4 },
  buttonPressed: { backgroundColor: palette.press },
  buttonPressedFilled: { opacity: 0.78 },
  buttonWithCaption: { gap: space.xs },
  buttonCaption: { ...type.meta, paddingHorizontal: space.xs },

  chip: {
    minHeight: 44,
    minWidth: 76,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.raised,
    paddingHorizontal: space.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipText: { fontSize: 15, fontWeight: '600', letterSpacing: -0.1 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: palette.surface,
    borderWidth: 1,
    borderColor: palette.line,
    borderRadius: radius.card,
    padding: space.lg,
    overflow: 'hidden',
  },
  rowPressed: { backgroundColor: palette.raised },
  // Flush to the card edge, like every other rail in the app: a 3px line
  // floating 16px in reads as a mistake rather than as an owner.
  rowRail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  rowTitle: { fontSize: 16, fontWeight: '600', color: palette.text, letterSpacing: -0.2 },
  rowSubtitle: { fontSize: 13, color: palette.muted, marginTop: 3 },
  rowMeta: { fontSize: 12, color: palette.muted, marginTop: 4, opacity: 0.85 },

  inputGroup: { gap: space.sm },
  input: {
    borderWidth: 1,
    borderColor: palette.line,
    backgroundColor: palette.raised,
    borderRadius: radius.control,
    paddingHorizontal: space.md,
    paddingVertical: space.md,
    fontSize: 16,
    color: palette.text,
    minHeight: 50,
  },

  notice: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    borderRadius: radius.control,
    paddingVertical: space.md,
    paddingRight: space.md,
    paddingLeft: space.md + 3,
    overflow: 'hidden',
  },
  noticeRail: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  noticeIcon: { marginTop: 1 },
  noticeText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: palette.text },

  pill: {
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: space.sm,
    paddingVertical: 2,
  },
  pillText: { fontSize: 11, fontWeight: '600', letterSpacing: 0.2 },

  statusLine: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  statusLabel: { ...type.label, width: 116 },
  statusValueWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.xs },
  statusValue: { flex: 1, fontSize: 14, fontWeight: '500', color: palette.text, lineHeight: 20 },

  field: { gap: space.xs, paddingVertical: space.sm },
  fieldDivided: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.line, paddingTop: space.md },
  fieldLabelRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  fieldLabel: { ...type.label },
  fieldValue: { fontSize: 15, color: palette.text, lineHeight: 22 },
  fieldToggle: { fontSize: 13, fontWeight: '600', color: palette.brand, paddingVertical: space.xs },
  fieldTogglePressed: { opacity: 0.6 },

  loading: { padding: space.xxxl, alignItems: 'center', gap: space.md },

  empty: { alignItems: 'center', paddingVertical: space.xxxl, paddingHorizontal: space.sm, gap: space.md },
  emptyIcon: {
    width: 58,
    height: 58,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.surface,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: palette.text, letterSpacing: -0.3 },
  emptyBody: {
    fontSize: 14,
    lineHeight: 21,
    color: palette.muted,
    textAlign: 'center',
    maxWidth: 300,
  },
  emptyAction: { alignSelf: 'stretch', paddingTop: space.sm },
});
