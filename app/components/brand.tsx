/**
 * AgentAction's own identity: the mark and the wordmark.
 *
 * The mark is a gate held shut, with the approval leaving through the single
 * opening — nothing passes until a person lets it. The paths are inlined from
 * `brand/mark.svg` rather than loaded from a file: an SVG loader would mean
 * another dependency and an asset resolved at runtime, for two paths that
 * never change.
 */
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';
import { palette, space } from '../lib/theme';

/**
 * Gradient ids are global to the SVG renderer, so two marks on one screen
 * would fight over `url(#…)`. A per-instance id costs nothing and removes the
 * whole class of problem.
 */
let instances = 0;
function useGradientId(): string {
  const [id] = useState(() => `aaMark${(instances += 1)}`);
  return id;
}

export function Mark({ size = 30 }: { size?: number }) {
  const id = useGradientId();
  return (
    <Svg width={size} height={size} viewBox="0 0 128 128">
      <Defs>
        <LinearGradient id={id} x1="16" y1="18" x2="112" y2="110" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor="#7FA6FF" />
          <Stop offset="1" stopColor="#4C7BFF" />
        </LinearGradient>
      </Defs>
      {/* The enclosure, opened at the top right. */}
      <Path
        d="M86 20H40a20 20 0 0 0-20 20v48a20 20 0 0 0 20 20h48a20 20 0 0 0 20-20V60"
        fill="none"
        stroke={`url(#${id})`}
        strokeWidth={12}
        strokeLinecap="round"
      />
      {/* The approval: begins inside, leaves through the gap. */}
      <Path
        d="M46 66l18 18L110 24"
        fill="none"
        stroke={palette.approve}
        strokeWidth={12}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * The wordmark, set in the system face rather than shipped as artwork: it has
 * to sit on the same baseline grid as everything else in the header, and a
 * bitmap of it would go soft on a high-density screen.
 */
export function Wordmark({ size = 21 }: { size?: number }) {
  return (
    <Text
      style={[styles.wordmark, { fontSize: size }]}
      accessibilityRole="header"
      allowFontScaling={false}
    >
      Agent<Text style={styles.wordmarkAccent}>Action</Text>
    </Text>
  );
}

/** Mark and wordmark together — the app's signature, used in app chrome. */
export function Lockup({ size = 30, wordmarkSize }: { size?: number; wordmarkSize?: number }) {
  return (
    <View style={styles.lockup}>
      <Mark size={size} />
      <Wordmark size={wordmarkSize} />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  wordmark: {
    fontWeight: '700',
    letterSpacing: -0.5,
    color: palette.text,
    // Keeps the two halves of the word on one optical line at any size.
    includeFontPadding: false,
  },
  wordmarkAccent: { color: palette.brand, fontWeight: '700' },
});
