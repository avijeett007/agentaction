---
name: agentaction-release
description: Use when cutting, building or publishing a release of the AgentAction phone app — "ship 0.1.2", "build a new APK", "publish a release", "why can't people install the update", "put the new build on GitHub", "submit to Play". Covers the version bump, the EAS build, the GitHub release with its checksum, and the Play submission, plus the traps that make a build look fine and install as broken.
---

# Releasing the AgentAction app

## Overview

Two channels, two artefacts, and they are **not interchangeable**:

| Channel | Artefact | Profile | Signed by | Who installs it |
|---|---|---|---|---|
| GitHub Release | `.apk` | `release-apk` | the EAS upload key | anyone with the link |
| Google Play | `.aab` | `production` | **Google's** key (Play App Signing) | Play users |

> **They cannot update each other.** Different signing keys. A phone holding the
> GitHub APK must **uninstall** before installing from Play, and uninstalling
> **wipes the pairing and the approval key held in secure hardware**, forcing a
> re-pair. Say this in the release notes on the day Play goes live; do not let
> users discover it.

Full prose walk-through: [`docs/releasing.md`](../../../docs/releasing.md).
Store accounts and the ordered launch plan: [`docs/store-launch.md`](../../../docs/store-launch.md).

## The four traps

Each of these produced a build that looked fine and was not. They are the reason
this skill exists.

### 1. A release with no EAS project id ships push permanently off

`app.json` is public, so the project id lives in a **gitignored** `app/eas.local.json`
or in `EAS_PROJECT_ID`. The local file **never reaches the EAS builder**. If the
variable is not set on the EAS project, `app.config.js` omits
`extra.eas.projectId`, `expo-notifications` can never mint a token, and the app
says so on its Settings screen.

The id is **baked into the binary**, so "Retry registration" can never repair an
installed build — it takes a new one.

```bash
# Must both be present, in EVERY environment, as PLAIN TEXT (not secret):
npx eas-cli env:list --environment production | grep -E 'EAS_PROJECT_ID|EAS_OWNER'
```

A release build now **refuses** rather than shipping this (`assertReleaseHasProjectId`
in `app/app.config.js`), covered by `app/test/appConfig.test.ts`. If that guard is
ever removed, this comes back silently.

### 2. `autoIncrement: false` ships a version Android will not install

Android refuses an APK whose `versionCode` is not **higher** than the installed
one — the error is the unhelpful "App not installed". `release-apk` once set
`autoIncrement: false`, overriding `production`, so a new version shipped with the
same code. Both release profiles now set it `true`. Check the build output says:

```
✔ Incremented versionCode from N to N+1
```

### 3. `tsc` OOMs, and an empty result reads like success

The repo exceeds Node's default heap. A crashed `tsc` prints nothing, which looks
exactly like a clean run.

```bash
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit
```

Always pass the heap flag, and **check the exit status**, not the silence.

### 4. Play takes a YouTube URL, not a video file

There is no video upload. Apple is the opposite — App Previews are uploaded
files, 15–30s, per-device specs. One cut can serve both; the delivery differs.

## Cutting a release

```bash
cd agentaction/app

# 1. Version. app.json `version` is the human one; versionCode auto-increments.
#    Keep it semver and keep it honest — a push fix is a patch, not a minor.

# 2. Checks. All three, and read the exit codes.
npx jest
npx next lint 2>/dev/null || npx eslint .
NODE_OPTIONS=--max-old-space-size=8192 npx tsc --noEmit

# 3. Build the downloadable APK.
export EAS_BUILD_NO_EXPO_GO_WARNING=true
npx eas-cli build --platform android --profile release-apk --non-interactive --no-wait

# 4. When it finishes, publish it. The script REFUSES a file it cannot identify
#    and always records the SHA-256 in the notes — a file handed out outside a
#    store has nothing vouching for it but its checksum.
cd ..
scripts/publish-build.sh v0.1.2 ~/Downloads/agentaction-0.1.2.apk
```

Then rewrite the notes to say what changed:

```bash
gh release edit v0.1.2 --repo avijeett007/agentaction --notes-file notes.md
```

**The portal's download link needs no change.** It resolves
`github.com/avijeett007/agentaction/releases/latest`, so a new release moves the
button and the QR code by itself.

## Submitting to Play

```bash
cd agentaction/app
npx eas-cli build  --platform android --profile production --non-interactive --no-wait
npx eas-cli submit --platform android --latest --non-interactive
```

`eas submit` creates the first release itself; nothing needs uploading by hand.
The service-account key is reached through a **gitignored symlink**
(`app/google-service-account.json` → `~/.config/agentaction/play-service-account.json`),
so the key never sits inside the repo. See the `agentaction-play` skill for
verifying that credential and for reading track state.

`eas.json` pins `track: internal`, so a plain `submit` cannot put a build in front
of real users. Promoting to production stays a deliberate act.

## Verifying, rather than trusting

```bash
# The release is genuinely public and downloadable, as a stranger sees it:
curl -sI https://github.com/avijeett007/agentaction/releases/latest | head -1
curl -sL -o /dev/null -w '%{http_code} %{size_download}\n' \
  https://github.com/avijeett007/agentaction/releases/download/vX.Y.Z/agentaction-X.Y.Z.apk
```

For Play, read the track back from the API rather than the CLI's word — see
`agentaction-play`.

## Red flags — stop

- About to publish a release and `EAS_PROJECT_ID` is not in the EAS environment → **stop**, the build ships push-dead.
- Build output did not say "Incremented versionCode" → **stop**, it will not install over the previous version.
- `tsc` printed nothing and you did not pass the heap flag → it crashed; you have not type-checked.
- About to tell users to "just install the Play version" while they hold the GitHub APK → they cannot, and uninstalling costs them their pairing.
