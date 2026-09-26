# Google Play — Data safety answers

Fill this in at **Play Console → App content → Data safety**. Every answer here is
checked against what the app actually does; where a claim comes from code, the file
is named so it can be re-checked when the code changes.

Play's definitions are narrower than they look, and two of them decide most of this
form:

- **Collected** — sent off the device *and* kept. Data that leaves, is used for the
  request, and is not retained is *not* "collected".
- **Shared** — passed to a *third party*. Your own server is not a third party.

---

## Section 1 — Data collection and security

| Question | Answer |
|---|---|
| Does your app collect or share any of the required user data types? | **Yes** |
| Is all of the user data collected by your app encrypted in transit? | **Yes** — every call is HTTPS |
| Do you provide a way for users to request that their data is deleted? | **Yes** — unpairing in the app, and `connect@agentaction.online` |

> Answering "No" to the first question would be wrong. The device name is chosen by
> the user and can identify a person, and the notification token is a device
> identifier. Both are retained until unpairing, so both are collected.

---

## Section 2 — Data types

### Declare: **Device or other IDs**

| Field | Answer |
|---|---|
| Collected | Yes |
| Shared | No |
| Processed ephemerally | No — kept until the phone is unpaired |
| Required or optional | **Optional** — declining notifications still leaves the app working; it polls |
| Purpose | **App functionality** only |

This is the push notification token, plus the public half of the device's signing
key. Source: `app/lib/push.ts`.

### Declare: **Personal info → Name** *(only because the user may type one)*

| Field | Answer |
|---|---|
| Collected | Yes |
| Shared | No |
| Processed ephemerally | No |
| Required or optional | **Optional** — the field is free text and may be "Work phone" |
| Purpose | **App functionality** only |

The device name shown in the pairing organisation's device list. The app never reads
a name from the account, the contacts or the OS — the user types it.

> Declaring this is the cautious reading. A user *may* type their own name, and Play
> treats a free-text field that can hold a name as collecting one. Declaring it and
> being wrong costs nothing; not declaring it and being wrong is a policy breach.

### Do **not** declare

| Data type | Why not |
|---|---|
| Photos or videos | The camera reads a pairing code. Nothing is captured, stored or transmitted. Declare under *Camera permission*, not as data collection. |
| Biometrics | The check is done by Android; the app receives only success or failure. No biometric data is accessible to the app, let alone sent. |
| Location, contacts, calendar, files, messages, health, financial info | Never requested and never accessed. |
| App activity / analytics / crash logs | There is no analytics SDK and no crash reporter in the app. |
| Advertising ID | Not present. The app contains no ads and no ad SDK. |

---

## Section 3 — The remaining declarations

| Declaration | Answer |
|---|---|
| Ads | **No ads** |
| Content rating questionnaire | Category **Utility**; answer *No* to violence, sexual content, profanity, drugs, gambling, user-generated content and user communication. Expect **PEGI 3 / Everyone**. |
| Target audience | **18+**. Not designed for or appealing to children. |
| News app | No |
| COVID-19 contact tracing or status | No |
| Government app | No |
| Financial features | **No** — the app approves actions; it does not process a payment, hold funds or offer credit |
| Data deletion URL | `https://agentaction.online/privacy` (deletion is explained there, under *Your rights*) |
| Privacy policy URL | `https://agentaction.online/privacy` |

---

## Section 4 — App access (the one that gets apps rejected)

The reviewer cannot use this app without a pairing code, and the listing says so.
If that is left unexplained the review fails as "cannot evaluate".

At **App content → App access**, choose *All or some functionality is restricted*
and give:

- What is restricted: pairing, and therefore every screen after it.
- Instructions: how the reviewer obtains a working pairing code and what to do with
  it, written step by step.
- A pairing code that is **valid at the time of review** and is not a customer's.

> Pairing codes expire. A code pasted here in the morning may be dead by the time a
> reviewer opens it, and the rejection reads like a broken app. Either provision a
> long-lived demo tenant for review, or be ready to re-submit the code when review
> starts.

---

## Section 5 — Permissions Play will ask about

| Permission | Declared reason |
|---|---|
| `CAMERA` | Scanning the pairing QR code shown by the organisation the user pairs with. Used once, nothing captured. |
| `USE_BIOMETRIC` / `USE_FINGERPRINT` | Releasing the on-device approval key so a decision can be signed. Required for every approval. |
| Notifications | Alerting the user that a request is waiting. |

`RECORD_AUDIO` is explicitly blocked in `app/app.json` (`blockedPermissions`), so it
should not appear. If Play reports it, a dependency has pulled it in and that needs
fixing before submission rather than explaining away.
