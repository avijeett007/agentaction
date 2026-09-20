/**
 * What AgentAction is, and who stands behind it.
 *
 * The credit at the bottom is deliberately parked here rather than anywhere
 * near a decision. Nothing may interrupt an approval to sell something, so the
 * only place the app mentions who built it is a screen the owner chose to open.
 */
import { useCallback, useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { DESCRIPTOR, SLOGAN, SLOGAN_SHORT, palette, space, type } from '../lib/theme';
import { AppHeader, Button, Card, Heading, Notice, Screen } from '../components/ui';
import type { IconName } from '../components/ui';

const SITE = 'https://sonti.io';

export function AboutScreen({ onBack }: { onBack: () => void }) {
  const [problem, setProblem] = useState<string | null>(null);

  // React Native's own Linking is enough for one outbound URL; expo-linking
  // would add a dependency for deep-link parsing this screen does not do.
  const openSite = useCallback(() => {
    setProblem(null);
    void Linking.openURL(SITE).catch(() =>
      setProblem(`Could not open a browser. The address is ${SITE}`),
    );
  }, []);

  const version = Constants.expoConfig?.version ?? null;

  return (
    <View style={styles.flex}>
      <AppHeader subtitle={SLOGAN_SHORT} onBack={onBack} />
      <Screen>
        <Card>
          <Text style={type.title}>{SLOGAN}</Text>
          <Text style={type.body}>{DESCRIPTOR}</Text>
          <Text style={styles.paragraph}>
            When an agent calls a tool that has been gated, the call does not run. It waits here.
            You see what is being asked, approve or deny it, and only then does it go ahead.
          </Text>
        </Card>

        <Card>
          <Heading>What makes a request trustworthy</Heading>
          <Point icon="keypad-outline">
            The four-digit code on the request is the same one the agent was given. If they do not
            match, you are not looking at the call you think you are.
          </Point>
          <Point icon="finger-print-outline">
            Your decision is signed by a key this phone releases only after Face ID, a fingerprint
            or your passcode. Nobody can approve on your behalf.
          </Point>
          <Point icon="document-text-outline">
            Arguments are shown as plain text and nothing else. They were written by a model, and
            a model must never be able to style or fake part of this screen.
          </Point>
        </Card>

        <Card>
          <Heading>Want this in your own stack?</Heading>
          <Text style={styles.paragraph}>
            AgentAction is an approval layer for agent tool calls, and it is not tied to one
            platform. Run the server yourself against your own gateway, or have the team who built
            it deploy and operate it alongside what you already have.
          </Text>
          <Text style={styles.paragraph}>
            Sonti does security-focused AI engineering: agent gateways, approval and audit paths,
            and the unglamorous parts that decide whether an agent is safe to hand a key to.
          </Text>
          {problem ? <Notice tone="warn">{problem}</Notice> : null}
          <Button title="Open sonti.io" icon="open-outline" onPress={openSite} />
        </Card>

        <View style={styles.footNotes}>
          {version ? <Text style={type.meta}>AgentAction {version}</Text> : null}
          <Text style={type.meta}>Built by Sonti.</Text>
        </View>
      </Screen>
    </View>
  );
}

function Point({ icon, children }: { icon: IconName; children: React.ReactNode }) {
  return (
    <View style={styles.point}>
      <Ionicons name={icon} size={18} color={palette.brand} style={styles.pointIcon} />
      <Text style={styles.pointText}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
  paragraph: { fontSize: 14.5, lineHeight: 22, color: palette.muted },
  point: { flexDirection: 'row', gap: space.md, alignItems: 'flex-start' },
  pointIcon: { marginTop: 2 },
  pointText: { flex: 1, fontSize: 14, lineHeight: 21, color: palette.muted },
  footNotes: { gap: space.xs, paddingHorizontal: space.xs, paddingTop: space.sm },
});
