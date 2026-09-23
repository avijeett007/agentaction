# Releasing the AgentAction app, step by step

Written for whoever ships a build. Follow it top to bottom; each step says what
it produces and how to know it worked.

There are two ways people get the app, and right now only the first is open:

| | Android | iPhone |
|---|---|---|
| **Now — downloads from this repo** | an `.apk` anyone can install | **not possible the same way** — Apple does not allow it. Use TestFlight (see [step 5](#5-iphone-until-the-app-store-testflight)) |
| **Later — the stores** | Google Play | App Store |

The store route is a separate document, [releasing-to-the-stores.md](releasing-to-the-stores.md),
because it is mostly account and review work. This one covers the build itself
and the interim downloads.

---

## Before your first release

One-time setup. Skip if you have released before.

1. **An Expo account with access to the project.**
   ```bash
   cd agentaction/app
   npx eas-cli login
   npx eas-cli whoami
   ```
2. **Android signing.** EAS generates and keeps a keystore the first time it
   builds. Let it:
   ```bash
   npx eas-cli credentials -p android
   ```
   > **This keystore is the app.** Every APK you hand out is signed with it, and
   > a phone will refuse an update signed by a different key. Do not regenerate
   > it between releases. `eas credentials` can export a backup — keep it
   > wherever your other irreplaceable keys live.
3. **iPhone signing** (only when you start doing iOS builds) needs an Apple
   Developer account and an interactive login with two-factor:
   ```bash
   npx eas-cli credentials -p ios
   ```
4. **The GitHub CLI**, for publishing the download:
   ```bash
   gh auth status
   ```

---

## 1. Decide the version

`app/app.json` holds the version people see: `"version": "0.1.0"`. Raise it for
every release you hand to anyone.

```bash
cd agentaction/app
# edit app.json → "version": "0.2.0"
```

Rule of thumb: `0.x.0` when the app gained or changed something a user would
notice, `0.x.y` for a fix. The build number underneath is handled by EAS
(`autoIncrement` on the production profile), so you never edit that by hand.

Commit the bump on its own, so the release tag has something to point at.

## 2. Check it before you build

A build takes ~15 minutes on EAS' queue; the checks take two.

```bash
cd agentaction/app
npx tsc --noEmit          # types
npx jest                  # unit tests
```

Then the things no test covers — run through
[device-smoke.md](device-smoke.md) on a real phone with the current code. At
minimum, before every public build:

- a request arrives as a notification while the app is **closed**;
- the code on the notification matches the code on the request;
- cancelling Face ID / the fingerprint prompt does **not** approve;
- denying really does refuse the action;
- the app shows no argument values on the lock screen.

## 3. Build

**Android, for download:**
```bash
cd agentaction/app
npx eas-cli build --platform android --profile release-apk
```
Produces an `.apk` signed with the release keystore. EAS prints a download URL
when it finishes, and `eas build:list` finds it again later.

**Android, for Google Play** (when you get there — Play wants a bundle, not an
APK):
```bash
npx eas-cli build --platform android --profile production
```

**iPhone:**
```bash
npx eas-cli build --platform ios --profile production
```

> Both platforms build in the cloud. `--local` works if you have Xcode or the
> Android SDK set up, but the signing story is the same either way.

## 4. Publish the Android download

The APK goes on a **GitHub Release**, which is what gives you the stable "latest
release" link to hand out.

```bash
# from the repo root, with the .apk downloaded next to you
agentaction/scripts/publish-build.sh v0.2.0 ~/Downloads/agentaction-0.2.0.apk
```

That script checks the file is really an APK, records its SHA-256, creates (or
updates) the release, uploads the file and prints the download link. Do it by
hand if you prefer:

```bash
shasum -a 256 agentaction-0.2.0.apk        # keep this, publish it
gh release create v0.2.0 agentaction-0.2.0.apk \
  --repo avijeett007/agentaction \
  --title "AgentAction 0.2.0" \
  --notes-file RELEASE_NOTES.md
```

**Publish the SHA-256 in the release notes.** It is the only way someone who
downloads an APK outside a store can tell they got the file you built.

The install instructions to give people are in the README's
[Download](../README.md#download-the-app) section — Android blocks installing
from outside Play until the user allows it for their browser, and they will hit
a scary-looking warning that is worth explaining in advance.

## 5. iPhone until the App Store: TestFlight

An `.ipa` is not an APK. Apple will only install one on a phone whose UDID was
baked into the build, so "download the iPhone file from the repo" does not work
for the public. There are exactly two honest options before the App Store:

**TestFlight (recommended).** Up to 10,000 external testers, a public link you
can put anywhere, and Apple reviews the build once — lighter and faster than a
full App Store review.

```bash
cd agentaction/app
npx eas-cli submit --platform ios --latest
```
Then in App Store Connect → TestFlight → External Testing, add a group, enable
the **public link**, and put that link in the README beside the APK.

**Ad-hoc, for a handful of known phones.** Collect each device's UDID, register
them, and build the `release-ios` profile. Installable by download, capped at
100 devices a year, and every new tester needs a new build. Only worth it for a
pilot with a named set of people.

```bash
npx eas-cli device:create            # register the phones first
npx eas-cli build --platform ios --profile release-ios
```

## 6. Write the release notes

Short, and written for the person installing it — not a changelog of commits.

```markdown
## AgentAction 0.2.0

What is new
- …

Install on Android
1. Download `agentaction-0.2.0.apk` below.
2. Open it. Android will ask whether to allow installs from your browser — say yes.
3. If you already have the app, this installs over it and keeps your pairings.

SHA-256: `…`

On iPhone: join the TestFlight beta — <link>
```

## 7. Tell the people who need to know

- Anyone already paired keeps working — a new build does not unpair anyone.
- If the release changes what a request looks like, say so: these are people who
  are being asked to approve real actions, and a surprise redesign is the moment
  they stop trusting what they see.

---

## When the stores open

Nothing about the download route changes. Keep publishing the APK for people who
do not use Play, and keep the SHA-256 with it. The two installs cannot update
each other, though — a phone that has the downloaded APK must uninstall it
before installing the Play version, because Play signs with its own key. Say that
in the release notes on the day you go live.

The store work itself is [releasing-to-the-stores.md](releasing-to-the-stores.md).

### Store listing text

Both stores ask for a description, and it is read by the person deciding to
install — not by the business that deployed the agent. Write it to them:

> **AgentAction — you decide what your AI assistant is allowed to do**
>
> An AI assistant can do real things for you: send an email, book an
> appointment, make a payment. For the ones that matter, it should have to ask
> you first. That is this app.
>
> When the assistant wants to do something that needs your say-so, the request
> appears here and your phone buzzes. You see exactly what it wants to do,
> then approve or refuse it. Nothing happens until you do.
>
> - Approve with Face ID, your fingerprint or your passcode — every time.
> - Every request carries a four-digit code, so you can tell a real one from a fake.
> - If you ignore a request, it expires and nothing happens.
> - No account, no sign-up, no tracking. Your approval key never leaves your phone.
>
> You will need a pairing code from whoever set up your assistant.
