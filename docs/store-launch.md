# Launching AgentAction in the stores — the ordered runbook

Start here. This is the sequence, from the accounts inward, with the things that
block you marked as blockers and the things that merely take time marked as waits.

Two other documents go deeper and this one links to them rather than repeating
them: [releasing.md](releasing.md) is how a release is built and published, and
[releasing-to-the-stores.md](releasing-to-the-stores.md) is the store mechanics.
[apple-duns-and-account.md](apple-duns-and-account.md) covers the D‑U‑N‑S number.

---

## 0. The identity question, first, because it is hard to change later

**Use one company address for both stores.** Not a personal address, not an
individual's name, and not an address that stops working when one person does.
Both stores tie the account to whoever registered it, and moving an app to a
different account later is either painful (Google) or impossible without a
transfer process (Apple).

The address should be at the company's own domain, and ideally a **shared mailbox
or group** rather than one person's inbox — store accounts receive review
decisions, policy warnings and expiry notices, and those must not sit unread
because one person is away.

### Does Google require a Gmail address?

**No.** A Play Developer account needs a *Google Account*, and a Google Account
can be created from any email address you already own. At the create-account
screen choose **"Use your existing email"** rather than accepting a new Gmail
address, enter your company address, and verify it with the code Google sends.

Two things follow from that:

- Your existing Apple ID address and your Play account can be **the same address**.
  They are separate accounts at separate companies; using one address for both is
  a convenience, not a conflict.
- If the domain is on Google Workspace, the address is already a Google Account
  and there is nothing to create — sign in with it.

> **Do not** register the Play account on a personal Gmail with the intention of
> moving it later. Google's account transfer exists but is a formal process, and
> until it completes the app belongs to whoever registered it.

### Which account type

**Organisation**, for both stores, because the entity is a company. On Google this
also avoids a rule that would otherwise cost two weeks — see step 2.

---

## 1. What is already done

Nothing below needs doing again. It is listed so the outstanding work is obvious.

| Thing | Where |
|---|---|
| Privacy policy, publicly reachable | https://agentaction.online/privacy |
| Terms of use | https://agentaction.online/terms |
| Store listing copy | [releasing.md](releasing.md), "Store listing text" |
| Data safety answers, with reasoning | [../store/play/data-safety.md](../store/play/data-safety.md) |
| 512×512 icon | `../store/play/icon-512.png` |
| 1024×500 feature graphic | `../store/play/feature-graphic-1024x500.png` |
| Signed Android App Bundle | Built by EAS, `production` profile |
| Downloadable APK, for people who cannot wait for the store | https://github.com/avijeett007/agentaction/releases/latest |

---

## 2. Google Play

Expect **a few hours to a few days** for the first review.

### 2.1 Create the account — *wait: up to 3 days*

[play.google.com/console](https://play.google.com/console) → sign in with the
company address → **Organisation** → pay the **US$25 one-off** fee (a real credit
or debit card; prepaid cards are refused).

Google then verifies the organisation. Have ready the legal entity name exactly as
registered, the registered address, a company website, and a contact address at
that domain. Identity verification may also ask for a government ID and a card in
the legal name of the person registering.

> **The rule you are avoiding by registering as an organisation:** personal
> accounts created after 13 November 2023 must run a closed test with **12 testers
> opted in for 14 continuous days** before they may even apply for production
> access. Organisation accounts are exempt. Registering personal "to get started
> quickly" costs three weeks.

### 2.2 Create the app — *5 minutes*

**Create app**, then:

| Field | Value |
|---|---|
| App name | `AgentAction` (max 30 characters) |
| Package name | `pro.knotie.agentaction` — then **Check availability** |
| Default language | English (United Kingdom). It defaults to en-US, but the listing copy, the privacy policy and the terms are all British English. |
| App or game | App |
| Free or paid | **Free** |

> **Two one-way doors on this one screen.**
>
> **Free is irreversible** — an app published as free can never be made paid. It is
> the right choice here, because the app is free and the money is in the service.
>
> **The package name is permanent.** It cannot be renamed or migrated; a different
> one is a different app, with its own listing, its own URL and its own installs.
> It is also public, in `play.google.com/store/apps/details?id=…`. Decided
> 2026-09-25: keep `pro.knotie.agentaction`, matching the shipped 0.1.1 APK.

**Automatic protection**: leave it **on**. It injects an installer check into the
build *Play* serves, so a copy extracted from Play and redistributed prompts the
user to get it from the store. The GitHub APK is a separate EAS `release-apk`
build that never passes through Play's processing, so the check is never injected
into it and its users are not nagged. Unlike the two above, this is reversible —
it can be turned off per release, and defaults back on for the next upload.

### 2.3 The service account, so builds upload themselves — *20 minutes, and it is the blocker*

Without this, every release is a manual file upload.

> **Google changed this.** Older guides (including an earlier version of this one)
> say *Play Console → Setup → API access → link a Google Cloud project*. That path
> no longer exists: "You no longer need to link your developer account to a Google
> Cloud Project in order to access the Google Play Developer API." The service
> account is created in Google Cloud and then *invited* into Play as a user.

**In Google Cloud Console** — [console.cloud.google.com](https://console.cloud.google.com)

1. Select or create a project. It only hosts the service account; nothing else
   about it matters.
2. **IAM & Admin → Service Accounts → Create Service Account**. Name it
   `eas-publisher`. The optional "grant access" steps can be skipped — the
   permissions that count are granted in Play, not here.
3. **Enable the "Google Play Android Developer API"** for that project. Miss this
   and submission fails with an error that never mentions an API.
4. Open the service account → **Manage keys → Add key → Create new key → JSON →
   Create**. It downloads once and cannot be downloaded again.
5. Copy the service account's **email address**
   (`eas-publisher@<project>.iam.gserviceaccount.com`).

**In Play Console**, at the account level rather than inside the app

6. **Users and permissions → Invite new users** → paste that email address.
7. Grant these, and no more than these:

   | Section | Permission |
   |---|---|
   | App access | View app information (read-only) |
   | Draft apps | Edit and delete draft apps |
   | Releases | Release to production, exclude devices, and use Play App Signing |
   | Releases | Release apps to testing tracks |
   | Releases | Manage testing tracks and edit tester lists |
   | Store presence | Manage store presence |

8. **Invite user**.

Keep the JSON out of the repository — store it outside the checkout and point EAS
at it, or upload it as an EAS secret.

> This JSON is **not** the FCM service account key used for push. Two different
> keys, both from Google Cloud, doing unrelated jobs. Mixing them up produces an
> authentication error that names neither.

> `eas submit` creates the app's first release itself. There is no need to upload
> a bundle by hand first.

### 2.4 Screenshots — *10 minutes, and only a person with the app can do it*

Play requires **at least two** phone screenshots, and they must show the real app.
Take them on a phone with the app installed:

1. The Waiting list with a request pending.
2. An open request, showing the four-digit code.
3. Accounts, showing a paired organisation.
4. Settings, showing the push token registered.

Requirements: PNG or JPEG, 16:9 or 9:16, each side between 320px and 3840px.

> Check each one before uploading. A screenshot showing a real pairing code, a real
> customer name or a real email address is a data leak published worldwide.

### 2.5 Content declarations — *30 minutes*

Work through **App content**. Every answer, and the reasoning behind it, is in
[../store/play/data-safety.md](../store/play/data-safety.md). Play blocks release
until all of them are complete.

The one that is easy to get wrong is **App access**. The reviewer cannot use this
app without a pairing code, and the listing says so. Left unexplained, the review
fails as "cannot evaluate" and reads like a broken app.

> **Pairing codes expire.** A code pasted into the form in the morning may be dead
> when a reviewer opens it. Either provision a long-lived demo tenant for review,
> or be ready to supply a fresh code the moment review starts. Never give a
> reviewer a customer's code.

### 2.6 Signing

Let Google manage the app signing key (**Play App Signing**). EAS holds the
*upload* key; Google holds the key that actually signs what users install.

> Because of this, the APK from GitHub and the build from Play are signed by
> **different keys**, and **cannot update each other**. Someone who installed the
> GitHub APK must uninstall it before installing the Play version — which wipes
> their pairing and their approval key. Say so plainly in the release notes on the
> day Play goes live.

### 2.7 Upload, test, promote

```bash
cd agentaction/app
npx eas-cli build   --platform android --profile production   # builds the .aab
npx eas-cli submit  --platform android --latest               # uploads it
```

Release to **internal testing** first: up to 100 testers by email, live within
minutes, no review wait. Work through [device-smoke.md](device-smoke.md) there.

Then promote **internal → production**. That is where the review happens.

---

## 3. Apple App Store

Expect **longer**, and start the D‑U‑N‑S step early because it gates everything.

### 3.1 D‑U‑N‑S and enrolment — *wait: days to two weeks*

Covered in full in [apple-duns-and-account.md](apple-duns-and-account.md). In
short: Apple needs a D‑U‑N‑S number for the legal entity, the legal name and
address must match the record exactly, and the contact address must be at the
company domain. **US$99/year.**

If you already hold the Apple Developer account, this is done — skip to 3.2.

### 3.2 The thing that has no Android equivalent

**Apple will not let people install an app from a download.** An `.ipa` runs only
on phones whose UDID was registered before the build, capped at 100 devices a year.
There is no iOS equivalent of the GitHub APK.

So before the App Store, the only honest route is a **TestFlight public link**:
up to 10,000 testers, a link anyone can open, and a review that is lighter than the
full App Store review.

Do not accept a plan that says "put the .ipa in the release". It cannot work.

### 3.3 Release

```bash
cd agentaction/app
npx eas-cli build  --platform ios --profile production
npx eas-cli submit --platform ios --latest
```

Then App Store Connect: listing, screenshots (Apple wants its own sizes), privacy
questionnaire — the same answers as
[../store/play/data-safety.md](../store/play/data-safety.md), asked differently —
and the review note.

### 3.4 The review note matters more here

Apple rejects apps it cannot evaluate, and rejects them faster than Google. The
note must give a working pairing code, say what the app does, and say plainly that
nothing can be tested without pairing. See
[releasing-to-the-stores.md](releasing-to-the-stores.md) for the wording.

---

## 4. The order to actually do it in

Sequenced so the waits overlap rather than stack:

1. **Today** — confirm the company address, and start Apple's D‑U‑N‑S check if the
   Apple account does not exist. It is the longest wait and nothing else depends on
   it.
2. **Today** — register or confirm the Play organisation account. Verification runs
   while you do everything else.
3. **While those wait** — take the screenshots, create the Play app, and decide how
   the reviewer gets a pairing code. The last one is a product decision, not an
   admin task, and it is the most common cause of rejection.
4. **When Play verification clears** — API access, service account JSON, upload to
   internal testing, run the device smoke list.
5. **When internal testing passes** — complete the declarations and promote to
   production.
6. **When Apple enrolment clears** — iOS credentials, TestFlight, then the App
   Store.

---

## 5. What is still outstanding

| Item | Who | Blocks |
|---|---|---|
| Play service account JSON | Owner | Every upload to Play |
| Phone screenshots | Owner | The Play listing |
| How a reviewer gets a pairing code | Owner — product decision | Both stores |
| Company number and registered office | Owner | The legal pages, and UK company law |
| iOS credentials (`eas credentials -p ios`) | Owner | Any iOS build |

The company number and registered office are missing from
https://agentaction.online/privacy, https://agentaction.online/terms and the site
footer, all of which name Kno2gether Labs Ltd without them.
