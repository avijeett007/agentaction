# AgentAction — the phone app

Expo (React Native). Receives approval requests for AI agent tool calls, shows
what is being approved, and signs the answer with a key the OS releases only
after Face ID or a fingerprint.

The EAS project is configured per installation — see "Building it yourself"
below. Nothing in this repository is tied to a particular Expo account.

## Build profiles (`eas.json`)

| Profile | What it is for |
|---|---|
| `simulator` | iOS Simulator build. Needs no Apple account. No camera, no biometrics, no push — layout and navigation only. |
| `development` | Dev client on a real device: JS reloads over the network, so screens can be changed without rebuilding. |
| `preview` | A standalone internal build — what a tester installs. Android is a plain APK; iOS needs each device's UDID registered. |
| `production` | Store builds: an AAB for Google Play, an App Store build for TestFlight. |

```bash
npx eas-cli build --platform android --profile preview   # APK, no Apple account needed
npx eas-cli build --platform ios --profile preview       # asks for Apple login the first time
```

## iOS needs one interactive run

Internal distribution needs a distribution certificate, a provisioning profile
and the UDID of every device that will install it. EAS can create all three, but
it has to sign in to the Apple account first, and that means a 2FA prompt — so
the first iOS build must be run by a person:

```bash
npx eas-cli device:create        # register the test phone
npx eas-cli build --platform ios --profile preview
```

For TestFlight without an interactive login, put an App Store Connect API key
(`.p8`) on the machine and point `EXPO_ASC_API_KEY_PATH`, `EXPO_ASC_KEY_ID` and
`EXPO_ASC_ISSUER_ID` at it.

`ITSAppUsesNonExemptEncryption` is declared `false` in `app.json`: the app uses
Ed25519 signatures for authentication and HTTPS, which is the standard
exemption. Worth confirming once against your own legal view.

## Pairing without a camera

The portal prints the pairing code as text under the QR image, with a copy
button. The app takes that same string: **Pair a phone → Enter the code
instead**. That covers the Simulator, a refused camera permission, and a camera
that simply will not focus.

## Pointing the app at a server

The pairing code carries the server URL, so nothing is configured in the app.
The app accepts any `https://` host, and `http://` only for `localhost`,
`127.0.0.1`, `10.x` and `192.168.x` — enough to test against a laptop on the
same Wi-Fi, without allowing a scanned QR code to send the app somewhere
arbitrary over plain HTTP.

## Push

Push tokens need the EAS `projectId`, which is now in `app.json`, and a real
build — Expo Go cannot get one. Push is on by default; an Expo access token is optional (it buys enhanced
security, not the ability to send) and `EXPO_PUSH_DISABLED=true` silences it.

Without push, nothing is lost in testing: the pending list is fetched whenever
the app opens or is pulled to refresh.

**Settings → Notifications** is the place to look when a phone is not buzzing.
It reports the permission state, whether a token was obtained and whether the
server has it, and the last error verbatim — `lib/push.ts` records failures
instead of swallowing them. **Retry registration** re-asks for permission,
fetches a fresh token and re-sends it even if it has not changed.

## Safe areas

Every screen measures the system insets with `react-native-safe-area-context`
and turns them into padding: headers add `insets.top`, the tab bar and the
pinned action footers add `insets.bottom`, and horizontal padding adds
`insets.left` / `insets.right` for cutouts and foldables.

The rule that matters is that **no touch target is ever drawn inside an
inset**. A Samsung Z Fold6 reserves 48px at the bottom for the gesture bar; the
tab bar is 60pt of touchable height *plus* that 48px as dead padding below it.
`tabBarLayout()` in `components/TabBar.tsx` states this once and
`test/tabbar.test.ts` holds it.

## Design

`lib/theme.ts` holds the whole system: the dark surface ramp, one four-based
spacing scale, one type ramp, and `themeFor()` for per-account branding.
AgentAction's blue is the app — the mark, the tab bar, anything before pairing.
An account's screens take that agency's colour, as a tint on the header, the
rail beneath it, the code and the primary action; `legibleAccent()` falls back
to the app blue when an agency's colour is too dark to read on the page.

`components/ui.tsx` is the visual vocabulary, `components/brand.tsx` the mark
and wordmark. The mark's paths are inlined from `../brand/mark.svg` rather than
loaded as a file.

## Tests

```bash
npx tsc --noEmit
npx jest
```

92 unit tests covering the signing protocol byte-for-byte, key storage, the API
client, account storage, the pairing payload rules and the tab bar's safe-area
contract. Anything needing a camera, biometrics, push or a real device is in
[docs/device-smoke.md](../docs/device-smoke.md), to be run by hand.
