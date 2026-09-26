---
name: agentaction-play
description: Use for anything involving the AgentAction app on Google Play — checking what Play actually holds, why a tester cannot install, why the opt-in link is missing, setting up or debugging the service-account credential, updating the store listing, discarding stray draft releases, or promoting a build between tracks. Also use when Play Console says something is "Verified" and it is not working.
---

# AgentAction on Google Play

## Overview

**Read the API, not the Console.** Play Console reports "Verified" on things that
are not working, and `eas` only knows about submissions it made. The API is the
only account of what Play actually holds.

```bash
node .claude/skills/agentaction-play/scripts/playctl.mjs <command>
```

| Command | Answers |
|---|---|
| `doctor` | Can we reach Play, and with what rights? Run this first, always. |
| `tracks` | What is on each track, and is it a draft or live? |
| `listing` | Is the store listing complete — title, descriptions, images? |
| `drafts` | What half-finished releases are lying around? |
| `discard <track>` | Remove a draft release. |
| `promote <from> <to>` | Move a completed release between tracks. |

Needs `googleapis` on `NODE_PATH` (the main repo's `node_modules` has it). The
credential lives at `~/.config/agentaction/play-service-account.json`, **outside
every checkout**; override with `PLAY_SERVICE_ACCOUNT_KEY`.

Package: `pro.knotie.agentaction` — **permanent**, and public in the store URL.

## The credential, and the three 403s

Google **changed this**. Older guides say *Play Console → Setup → API access →
link a Cloud project*; that path no longer exists. The service account is created
in Google Cloud and then **invited into Play as a user**.

1. Google Cloud → **IAM & Admin → Service Accounts → Create Service Account**.
2. **Enable the "Google Play Android Developer API"** for that project. Skipping
   this fails submission with an error that never names an API.
3. The account → **Manage keys → Add key → JSON**. Downloads once, never again.
4. Play Console → **Users and permissions → Invite new users** → the service
   account's email → grant: *View app information*, *Edit and delete draft apps*,
   *Release to production…*, *Release apps to testing tracks*, *Manage testing
   tracks*, *Manage store presence*.

**Three different problems all present as a 403**, which is why `doctor` exists:
the account was never invited; the invite is still pending; or the app does not
exist under that package name. A *disabled API* reads differently — it names the
API and says `SERVICE_DISABLED`.

> This JSON is **not** the FCM key used for push. Two keys, both from Google
> Cloud, unrelated jobs. Confusing them produces an error naming neither.

## "Why can't my tester install it?"

Work down this list; each has been the real cause at least once.

1. **The opt-in link is missing entirely.** Testing → Internal testing → Testers
   shows *"The link will be shown here when you publish your app."* That means
   Play does not consider the app publishable yet — almost always an **incomplete
   store listing** or unfinished **App content** declarations. Check with
   `playctl listing`; every declaration answer is in
   [`store/play/data-safety.md`](../../../store/play/data-safety.md).

2. **The link 404s for that person.** Play resolved it against a Google account
   that is not on the tester list. Usually several accounts are signed into the
   browser and Play used the first. Open it in a private window signed into only
   the tester account, or append `?authuser=N`.

3. **"Something went wrong on our end."** Play's own server error. Either the
   release is still propagating (30 minutes to a few hours after a first
   internal-test release) or the phone already holds the **GitHub APK**.

4. **The install fails outright.** Same package, different signing key: Play's
   build cannot replace a sideloaded one. They must uninstall first — which
   **wipes the pairing and the approval key**, forcing a re-pair.

Creating an email list under *Users and permissions* does **not** attach it to a
track. The Internal testing → Testers tab has to select it.

## Store listing

`playctl listing` reports what is live. To change it, read the listing first and
send the whole object — the API replaces rather than merges.

Requirements that reject silently if wrong:

| Asset | Requirement |
|---|---|
| Icon | 512×512, 32-bit PNG **with** alpha |
| Feature graphic | 1024×500, JPEG or 24-bit PNG, **no alpha** |
| Phone screenshots | ≥2, 320–3840px a side, **longest side ≤ 2× the shortest** |
| Short description | ≤80 chars |
| Full description | ≤4000 chars |

> The aspect rule catches real phone screenshots. A 834×2048 capture is 2.456:1
> and **is rejected**. Pad the sides to 1152×2048 (9:16) with the app's own
> background so the padding is invisible.

> **Check every screenshot for real data.** A capture of a working app contains
> real email addresses, device names and sometimes live verification codes, and a
> store listing publishes them worldwide.

## Traps that are permanent

| Decision | Why it cannot be undone |
|---|---|
| **Package name** | Never renameable. A different one is a different app, with its own listing, URL and installs. |
| **Free vs paid** | A free app can never become paid. |
| **App signing key** | Fixed the moment you publish to an **open** track. A draft sitting on `beta` is one click from this — `playctl drafts` finds them. |

Automatic protection (the installer check) is **not** one of these: it can be
turned off per release. Leave it on — it is injected into the build *Play*
serves, so a copy extracted from Play and redistributed prompts the user to get
it from the store, while the GitHub APK never passes through Play's processing
and is unaffected.

## Reviewer access

The reviewer **cannot create an account** — Play says so explicitly — and pairing
codes **expire in 5 minutes and are single-use**, so a code pasted into the form
is dead before anyone opens it.

The working answer is a **standing demo account in the portal**: the reviewer
signs in and mints their own fresh code. The exact field-by-field wording is in
[`store/play/data-safety.md`](../../../store/play/data-safety.md) §4.

## Track ladder

`internal` (100 testers, no review, minutes) → `alpha` (closed) → `beta` (open,
public, reviewed) → `production`.

`eas.json` pins submissions to `internal`, so a plain `eas submit` cannot reach
real users. Promotion is deliberate: `playctl promote internal production`.

## Red flags — stop

- About to create a release in Play Console because a track "looks empty" → run `playctl tracks` first; `eas submit` has probably already made one and you are about to create a second, empty draft.
- On a **Create open testing release** screen while looking for a tester link → wrong track, and publishing there fixes your signing key forever.
- About to paste a pairing code into App access → it will be dead. Give a demo account instead.
- Trusting "Verified" in the Console → verify with `playctl doctor`.
