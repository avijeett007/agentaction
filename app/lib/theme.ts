/**
 * Design tokens, and the per-account branding rules.
 *
 * Two identities live side by side and must not be confused. AgentAction's own
 * blue is the *app*: the tab bar, the headers you see before anything is
 * paired, the mark. An agency's colour is the *account*: once a screen is
 * about one account, that account's colour carries it, so the owner can tell
 * at a glance which of their agencies is asking for something.
 *
 * The surface ramp is dark on purpose. This screen is read in a hurry, often
 * one-handed and often at night, and a white sheet at 11pm is a worse place to
 * make an irreversible decision than a quiet one.
 */
import { StyleSheet } from 'react-native';
import type { Brand } from './accounts';

export const palette = {
  /** The page behind everything. */
  ink: '#0A0E1A',
  /** Cards and the header band. */
  surface: '#141B2D',
  /** Inputs, code slabs, the one step above a card. */
  raised: '#1B2437',
  /** Hairlines and card borders. */
  line: '#22304D',
  text: '#F2F5FA',
  muted: '#8FA0BF',
  /** AgentAction itself. */
  brand: '#5B8CFF',
  approve: '#2FD98B',
  deny: '#FF5A5F',
  hold: '#FFB020',

  // React Native has no colour-mix, so each signal colour's wash over `ink` is
  // written out once here rather than guessed at every call site.
  brandWash: 'rgba(91,140,255,0.12)',
  approveWash: 'rgba(47,217,139,0.12)',
  denyWash: 'rgba(255,90,95,0.12)',
  holdWash: 'rgba(255,176,32,0.12)',

  /** What a pressable sitting on `surface` looks like while held. */
  press: 'rgba(242,245,250,0.07)',
  /** What a pressable sitting on `ink` looks like while held. */
  pressDeep: 'rgba(242,245,250,0.05)',
} as const;

/** One spacing scale, four-based. Nothing in the app uses a value outside it. */
export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  control: 12,
  card: 16,
  hero: 20,
  pill: 999,
} as const;

/**
 * One type ramp, system faces only.
 *
 * Loading a webfont would cost a blank frame on a screen that exists to be
 * read immediately, and the system face is the one the owner's eye is already
 * calibrated to. Numbers that tick — the code and the countdown — are set
 * tabular so their width never changes under them.
 */
export const type = StyleSheet.create({
  /** The four-digit code. The single loudest thing in the app. */
  code: {
    fontSize: 40,
    fontWeight: '800',
    letterSpacing: 8,
    fontVariant: ['tabular-nums'],
  },
  codeSmall: {
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: 3,
    fontVariant: ['tabular-nums'],
  },
  title: { fontSize: 23, fontWeight: '700', color: palette.text, letterSpacing: -0.4, lineHeight: 30 },
  heading: { fontSize: 17, fontWeight: '600', color: palette.text, letterSpacing: -0.2 },
  body: { fontSize: 15, fontWeight: '400', color: palette.text, lineHeight: 22 },
  /** Field and section labels. Sentence case: an argument name is easier to
   *  read as its author wrote it than shouted back in capitals. */
  label: { fontSize: 13, fontWeight: '600', color: palette.muted, letterSpacing: 0.1 },
  meta: { fontSize: 12, fontWeight: '500', color: palette.muted, lineHeight: 17 },
  button: { fontSize: 16, fontWeight: '600', letterSpacing: -0.1 },
});

export const NEUTRAL_BRAND: Brand = {
  name: 'AgentAction',
  logoUrl: null,
  color: palette.brand,
};

/** What the app says about itself. One place, so the wording cannot drift. */
export const SLOGAN = 'Agents act. Your users decide.';
export const SLOGAN_SHORT = 'Your users decide.';
export const DESCRIPTOR = 'Human approval for agent tool calls.';

export interface Theme {
  brand: Brand;
  /** The brand colour, guaranteed to be a usable hex value. */
  accent: string;
  /**
   * Ink or white, whichever stays readable on the raw accent. Only for a
   * surface genuinely filled with `accent`; filled controls use `onLegible`.
   */
  onAccent: string;
  /**
   * The accent, or AgentAction's blue when the accent is too dark to be seen
   * against the page. Anything that has to *read* as the agency — the code, a
   * rail, a filled button — uses this.
   */
  legible: string;
  /** Ink or white, whichever stays readable on `legible`. */
  onLegible: string;
}

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function normaliseColour(value: string | null | undefined): string {
  return typeof value === 'string' && HEX.test(value) ? value : NEUTRAL_BRAND.color;
}

function expand(hex: string): [number, number, number] {
  const h = hex.slice(1);
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/**
 * WCAG relative luminance, so a pale brand colour gets dark text rather than
 * white-on-yellow. Agencies pick their own colours and some of them are pale.
 */
export function readableTextOn(hex: string): string {
  const [r, g, b] = expand(normaliseColour(hex)).map(v => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.45 ? palette.ink : '#FFFFFF';
}

export function themeFor(brand: Brand | null | undefined): Theme {
  const resolved: Brand = brand ?? NEUTRAL_BRAND;
  const accent = normaliseColour(resolved.color);
  const legible = legibleAccent(accent);
  return {
    brand: { ...resolved, color: accent },
    accent,
    onAccent: readableTextOn(accent),
    legible,
    onLegible: readableTextOn(legible),
  };
}

/**
 * A dark brand colour disappears against `ink`, and agencies do pick near
 * black — the colour is usually chosen for a white website. Substituting
 * AgentAction's blue keeps the screen readable; the agency is still named,
 * and still shown by its logo where it has one.
 */
export function legibleAccent(accent: string): string {
  const [r, g, b] = expand(normaliseColour(accent));
  // Rough perceptual brightness. Below this the colour is indistinguishable
  // from the page.
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness < 70 ? palette.brand : accent;
}
