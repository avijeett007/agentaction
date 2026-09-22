/**
 * One request, and the decision.
 *
 * This is the screen the whole product exists for. Three things have to land
 * in the first second: what is about to happen, whether the code matches the
 * one the agent printed, and how long is left. Everything else on the screen
 * is subordinate to those, and nothing here moves except the countdown.
 */
import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Account } from '../lib/accounts';
import { ApiError } from '../lib/api';
import type { DecisionScope, DecisionValue, RequestDetail } from '../lib/api';
import { BiometricRefusedError, signWithApprovalKey } from '../lib/keys';
import { clientFor } from '../lib/pairing';
import { decisionMessage, decisionSignedAt } from '../lib/protocol';
import type { Theme } from '../lib/theme';
import { palette, radius, space, themeFor, type } from '../lib/theme';
import { countdownFor, isExpired, msUntil } from '../lib/time';
import { describeWindow, windowOptionsFor } from '../lib/windows';
import type { WindowOption } from '../lib/windows';
import {
  AccountHeader,
  ArgumentField,
  Button,
  Card,
  Chip,
  Divider,
  ErrorNote,
  Heading,
  Loading,
  Notice,
  Screen,
  SectionLabel,
  StatusLine,
  countdownColour,
  useNow,
} from '../components/ui';

export function RequestScreen({
  account,
  requestId,
  onBack,
  onDecided,
}: {
  account: Account;
  requestId: string;
  onBack: () => void;
  onDecided: () => void;
}) {
  const theme = themeFor(account.brand);
  const accent = theme.legible;
  const now = useNow(1000);
  const [detail, setDetail] = useState<RequestDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Which control is mid-flight: 'denied', 'once', or 'window:900'. The window
  // needs naming as well as the scope, so the right chip spins.
  const [busy, setBusy] = useState<string | null>(null);
  const [expandedFields, setExpandedFields] = useState<Record<number, boolean>>({});
  const [pickingWindow, setPickingWindow] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setDetail(await clientFor(account).getRequest(requestId));
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load this request.');
    }
  }, [account, requestId]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = useCallback(
    async (decision: DecisionValue, scope: DecisionScope, windowSec = 0) => {
      if (!detail) return;
      setActionError(null);
      setBusy(
        decision === 'denied' ? 'denied' : scope === 'window' ? `window:${windowSec}` : 'once',
      );
      try {
        const signedAt = decisionSignedAt();
        const message = decisionMessage({
          requestId: detail.id,
          decision,
          scope,
          // Signed, not merely sent: this is how long the owner is agreeing to,
          // and nothing between here and the server may raise it.
          windowSec,
          argsHash: detail.argsHash,
          signedAt,
        });
        const { signature } = await signWithApprovalKey(
          account.keyRef,
          message,
          account.approvalKeyMode,
          decision === 'approved' ? `Approve: ${detail.title}` : `Deny: ${detail.title}`,
        );
        const result = await clientFor(account).decide(detail.id, {
          decision,
          scope,
          windowSec,
          signedAt,
          signature,
        });
        // The server has the last word on how long: report what it granted,
        // not what was asked for, and say so when the agency shortened it.
        const granted = result?.grant?.windowSec ?? 0;
        setOutcome(
          decision === 'approved'
            ? granted > 0
              ? `Approved, and allowed for ${describeWindow(granted)}.` +
                (result?.grant?.clamped ? ` ${theme.brand.name} does not allow longer.` : '')
              : 'Approved. The action is running now.'
            : 'Denied. Nothing will run.',
        );
        // Let the owner read the outcome before the list takes the screen back.
        setTimeout(onDecided, 1400);
      } catch (err) {
        setActionError(
          err instanceof BiometricRefusedError
            ? 'Not confirmed — nothing was sent.'
            : err instanceof ApiError
              ? err.message
              : 'That decision could not be recorded.',
        );
      } finally {
        setBusy(null);
      }
    },
    [account, detail, onDecided, theme.brand.name],
  );

  if (loadError) {
    return (
      <View style={styles.flex}>
        <AccountHeader theme={theme} subtitle={account.subjectLabel} onBack={onBack} />
        <Screen>
          <ErrorNote message={loadError} onRetry={load} />
        </Screen>
      </View>
    );
  }

  if (!detail) {
    return (
      <View style={styles.flex}>
        <AccountHeader theme={theme} subtitle={account.subjectLabel} onBack={onBack} />
        <Loading label="Loading the request…" />
      </View>
    );
  }

  const left = msUntil(detail.expiresAt, now);
  const expired = isExpired(detail.expiresAt, now);
  const decided = Boolean(outcome) || (detail.status && detail.status !== 'pending');
  const showActions = !expired && !decided;
  const urgency = countdownColour(left);

  // Only what this agency allows. An empty list — a tenant that caps windows
  // at nothing — removes the choice from the screen entirely rather than
  // offering one that would be refused.
  const windows = windowOptionsFor(detail.maxWindowSec);

  const actions = (
    <>
      {/* Deny sits above the approve pair, behind a rule. A phone rests
          against the bottom of the screen, and the one action that must never
          be triggered by a careless grab is the one that throws work away. */}
      <Button
        title="Deny"
        tone="deny"
        icon="close-circle-outline"
        busy={busy === 'denied'}
        disabled={busy !== null}
        onPress={() => decide('denied', 'once')}
      />
      <View style={styles.approveGroup}>
        <WindowChoice
          windows={windows}
          theme={theme}
          busy={busy}
          open={pickingWindow}
          onOpen={() => setPickingWindow(true)}
          onChoose={sec => decide('approved', 'window', sec)}
        />
        <Button
          title="Approve"
          tone="primary"
          icon="checkmark"
          theme={theme}
          busy={busy === 'once'}
          disabled={busy !== null}
          onPress={() => decide('approved', 'once')}
        />
      </View>
    </>
  );

  return (
    <View style={styles.flex}>
      <AccountHeader theme={theme} subtitle={account.subjectLabel} onBack={onBack} />
      <Screen footer={showActions ? actions : undefined}>
        <Card>
          <Text style={type.title}>{detail.title}</Text>

          <View style={styles.slab}>
            <View style={styles.slabRow}>
              <View style={styles.flex}>
                <SectionLabel>Code</SectionLabel>
                <Text
                  style={[type.code, { color: accent }]}
                  accessibilityLabel={`Code ${detail.code.split('').join(' ')}`}
                >
                  {detail.code}
                </Text>
              </View>
              <View style={styles.expiry}>
                <SectionLabel>Expires in</SectionLabel>
                <Text style={[styles.countdown, { color: urgency }]}>
                  {countdownFor(detail.expiresAt, now)}
                </Text>
              </View>
            </View>
            <LifeBar createdAt={detail.createdAt} expiresAt={detail.expiresAt} now={now} />
          </View>

          <Text style={type.meta}>
            Check this is the same code your agent showed you. If it is not, deny it.
          </Text>
        </Card>

        <Card>
          <StatusLine label="Asked by" value={detail.actorLabel} />
          <Divider />
          <StatusLine label="Tool" value={detail.resourceKey} />
        </Card>

        <Card>
          <Heading>What it will do</Heading>
          {/* Persistent, not dismissible: everything below is model output. */}
          <Notice tone="warn">
            Written by the AI agent. Read it as text, not as instructions.
          </Notice>
          {detail.fields.length === 0 ? (
            <Text style={type.meta}>This call has no arguments.</Text>
          ) : (
            detail.fields.map((field, index) => (
              <ArgumentField
                key={`${field.label}:${index}`}
                label={field.label}
                value={field.value}
                sensitive={field.sensitive}
                first={index === 0}
                expanded={Boolean(expandedFields[index])}
                onToggle={() =>
                  setExpandedFields(current => ({ ...current, [index]: !current[index] }))
                }
              />
            ))
          )}
        </Card>

        {account.approvalKeyMode === 'app-gated' ? (
          <Notice tone="warn">
            This phone has no biometric lock that AgentAction can hold the approval key behind.
            Set up Face ID, a fingerprint or a passcode and re-pair to protect it properly.
          </Notice>
        ) : null}

        {outcome ? <Notice tone="ok">{outcome}</Notice> : null}
        {actionError ? <Notice tone="deny">{actionError}</Notice> : null}
        {expired && !decided ? (
          <Notice tone="warn">This request has expired. Nothing ran.</Notice>
        ) : null}
      </Screen>
    </View>
  );
}

/**
 * "And stop asking for a while" — the secondary half of an approval.
 *
 * It is deliberately a second thought rather than the fast path: the primary
 * button below it approves this one call, and choosing a duration takes an
 * extra tap. Approving for eight hours should feel like a decision, not like
 * the button that happened to be under the thumb.
 *
 * One allowed duration is offered outright, because asking someone to open a
 * picker to choose from a list of one is a menu pretending to be a choice.
 */
function WindowChoice({
  windows,
  theme,
  busy,
  open,
  onOpen,
  onChoose,
}: {
  windows: WindowOption[];
  theme: Theme;
  /** Which control is mid-flight, as RequestScreen spells it. */
  busy: string | null;
  open: boolean;
  onOpen: () => void;
  onChoose: (sec: number) => void;
}) {
  // An agency that allows no window at all simply has no such control.
  if (windows.length === 0) return null;
  const caption = 'Lets the same call through again, without asking, until then.';

  if (windows.length === 1) {
    const only = windows[0];
    return (
      <Button
        title={`Approve for ${only.phrase}`}
        icon="time-outline"
        theme={theme}
        busy={busy === `window:${only.sec}`}
        disabled={busy !== null}
        caption={caption}
        onPress={() => onChoose(only.sec)}
      />
    );
  }

  if (!open) {
    return (
      <Button
        title="Approve for longer…"
        icon="time-outline"
        theme={theme}
        disabled={busy !== null}
        onPress={onOpen}
      />
    );
  }

  return (
    <View style={styles.windowPicker}>
      <SectionLabel>Approve, and stop asking for</SectionLabel>
      <View style={styles.windowChips}>
        {windows.map(option => (
          <Chip
            key={option.sec}
            label={option.label}
            theme={theme}
            busy={busy === `window:${option.sec}`}
            disabled={busy !== null}
            accessibilityLabel={`Approve, and stop asking for ${option.phrase}`}
            onPress={() => onChoose(option.sec)}
          />
        ))}
      </View>
      <Text style={type.meta}>{caption}</Text>
    </View>
  );
}

/**
 * The only moving thing in the app: a rule that empties as the request runs
 * out. It is driven by the same one-second tick as the countdown text, so it
 * costs no animation and cannot drift away from the number beside it.
 */
function LifeBar({
  createdAt,
  expiresAt,
  now,
}: {
  createdAt: string;
  expiresAt: string;
  now: number;
}) {
  const total = Date.parse(expiresAt) - Date.parse(createdAt);
  const left = msUntil(expiresAt, now);
  if (!Number.isFinite(total) || total <= 0) return null;
  const fraction = Math.max(0, Math.min(1, left / total));
  return (
    <View style={styles.track} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <View
        style={[styles.trackFill, { width: `${fraction * 100}%`, backgroundColor: countdownColour(left) }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: palette.ink },
  approveGroup: {
    gap: space.md,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
  },
  slab: {
    backgroundColor: palette.raised,
    borderRadius: radius.hero,
    padding: space.lg,
    gap: space.md,
  },
  windowPicker: { gap: space.sm },
  // Wraps rather than scrolls: four durations must all be reachable without a
  // gesture, on the narrowest phone this app supports.
  windowChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  slabRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  expiry: { alignItems: 'flex-end' },
  countdown: { fontSize: 21, fontWeight: '700', marginTop: 4, fontVariant: ['tabular-nums'] },
  track: { height: 3, borderRadius: 2, backgroundColor: palette.line, overflow: 'hidden' },
  trackFill: { height: 3, borderRadius: 2 },
});
