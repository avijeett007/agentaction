/**
 * What AgentAction is, for the person holding the phone.
 *
 * Written to THEM, not about them. Whoever set the agent up already knows what
 * a tool call is; the person being asked to approve one may have installed this
 * because a company told them to, and is owed a plain answer to "what is this
 * and why is it asking me?". So: no "tool call", no "gated", no "your users",
 * and nothing that assumes they run anything.
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
            An AI assistant is doing some work for you — answering messages, booking things,
            moving money. For the steps that matter, it is not allowed to just go ahead. It has to
            ask you first.
          </Text>
          <Text style={styles.paragraph}>
            That is what this app is. When the assistant wants to do one of those things, the
            request appears here and your phone buzzes. You read what it wants to do, then approve
            or refuse it. Nothing happens until you do, and if you refuse, nothing happens at all.
          </Text>
        </Card>

        <Card>
          <Heading>Where the requests come from</Heading>
          <Text style={styles.paragraph}>
            From whoever set up the assistant — your company, or a service you use. You pair this
            phone with them once, by scanning their code, and you can unpair at any time from
            Accounts. You can be paired with more than one.
          </Text>
          <Text style={styles.paragraph}>
            They choose which actions need your say-so. You are not signing up to anything here:
            there is no account to create, and the app asks you for nothing but a decision.
          </Text>
        </Card>

        <Card>
          <Heading>How to know a request is real</Heading>
          <Point icon="keypad-outline">
            Every request shows a four-digit code, and the assistant was given the same one. If the
            code you are told does not match the code on screen, this is not the request you think
            it is. Refuse it.
          </Point>
          <Point icon="finger-print-outline">
            Approving needs Face ID, your fingerprint or your passcode — every time. Nobody can
            approve in your name, not even someone holding your unlocked phone.
          </Point>
          <Point icon="document-text-outline">
            What the assistant wants to do is shown as plain text, exactly as it wrote it. It
            cannot make anything bold, hide anything, or dress a request up to look official.
          </Point>
          <Point icon="time-outline">
            A request expires. If you do nothing, nothing happens — the assistant is refused by
            default, not allowed by default.
          </Point>
        </Card>

        <Card>
          <Heading>What this app can see</Heading>
          <Point icon="eye-off-outline">
            Only what you are asked to approve. It cannot read your messages, your files or
            anything else on this phone.
          </Point>
          <Point icon="cloud-offline-outline">
            There is no account, no sign-up and no tracking. Your approval key never leaves this
            phone.
          </Point>
          <Point icon="camera-outline">
            The camera is used once, to read a pairing code. Nothing is photographed or kept.
          </Point>
        </Card>

        <Card>
          <Heading>Run it yourself</Heading>
          <Text style={styles.paragraph}>
            If you are the one setting an assistant up rather than approving its work, AgentAction
            is open source and can run on your own servers.
          </Text>
          {problem ? <Notice tone="warn">{problem}</Notice> : null}
          <Button title="Open sonti.io" icon="open-outline" onPress={openSite} />
        </Card>

        <View style={styles.footNotes}>
          {version ? <Text style={type.meta}>AgentAction {version}</Text> : null}
          <Text style={type.meta}>A Kno2gether Labs product.</Text>
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
