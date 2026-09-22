<p align="center">
  <img src="brand/mark.svg" alt="" width="96" height="96">
</p>

<h1 align="center">AgentAction</h1>

<p align="center">
  <strong>Agents act. Your users decide.</strong><br>
  Human approval for agent tool calls.
</p>

---

AI agents no longer just write text. They send the email, move the money,
cancel the booking, rebuild the server. An agent that has been prompt-injected
by a web page it read — or that has simply misread the situation — is one tool
call away from doing the damage, and it will do it confidently.

AgentAction puts a person in front of that one call. It sits at the **tool
layer**: inside your MCP server, your API gateway, or wherever an agent's call
turns into a real action. When a call matches a rule, it is parked instead of
run. The phone belonging to whoever owns the account is asked. The action runs
only after that person approves it with Face ID or a fingerprint — and the
approval is signed and bound to the exact arguments, so what they saw is what
runs.

Two people tend to want this for different reasons:

- **If you are building the agent product** — it goes in at the tool layer.
  A handful of API calls around the place where you execute. No change to the
  agent, the model or the prompt.
- **If you have to answer for the agent product** — you can show that no
  irreversible action happened without a named human approving it, with a
  signed record and an audit trail to prove it.

## How it works

1. Your gateway asks AgentAction whether this tool call needs a human.
2. If it does not, the call runs exactly as it does today.
3. If it does, you park the call and keep the arguments. You send AgentAction
   only what the phone should display, plus a SHA-256 hash of the arguments.
4. Every phone paired to that account is notified.
5. The person opens it, reads who asked and what for, and approves or denies.
   Approving releases a key the operating system only hands over after
   biometrics; that key signs the decision, over the argument hash.
6. AgentAction posts you a signed webhook. You re-check the hash and run the
   call — once.
7. Nobody answers, or someone denies: nothing runs.

```
agent ──tool call──▶ your gateway ──┬── not gated ────────────────▶ runs as before
                                    │
                                    └── gated
                                         │ 1  park it; you keep the arguments
                                         │ 2  POST /v1/requests ──────▶ AgentAction
                                         │    (display text + args hash)      │
                                         │                               push │
                                         │                                    ▼
                                         │                            the phone: what,
                                         │                            who asked, Face ID,
                                         │                            signs the decision
                                         │ 3  signed webhook ◀────────────────┘
                                         │ 4  re-check the hash, run it once
                                         ▼
                                    result to the agent
```

## Why not just ask in the chat

Because an "are you sure?" in a terminal is not a control.

It arrives in the same channel the attack came through. It is answered by
whoever happens to be at the keyboard, which may be the agent's own loop. It
asks about a summary the agent wrote, not the arguments that will actually be
sent. And when it is over there is nothing left to show anyone.

A separate device, a biometric prompt, a signature over the exact arguments,
and a record left behind: that fixes all four. It is the whole idea, and
everything in this repository is in service of it.

## What is in this repository

| Directory | What it is |
|---|---|
| `server/` | The approval server. Express, Prisma, SQLite for development and Postgres in production. Tenants, subjects, pairing, devices, policies, requests, decisions, grants, push, webhooks, audit. See [server/README.md](server/README.md). |
| `sdk/` | `@agentaction/sdk` — the typed client an integrator uses, plus webhook verification and the canonical argument hash. |
| `app/` | The phone app. Expo / React Native, iOS and Android. Pairing, the pending list, the approval screen, settings. See [app/README.md](app/README.md). |
| `brand/` | The mark, the wordmark and the palette. See [brand/README.md](brand/README.md). |
| `docs/` | [Running it in production](docs/production.md) (Docker, Postgres, Supabase, Coolify, several instances), [multi-tenancy](docs/multi-tenancy.md) (Enterprise), and the [device test plan](docs/device-smoke.md). |
| `site/` | The landing page at agentaction.online. |

The approval server never executes anything. It decides *who approved what*.
You hold the arguments and you run the action.

## Quick start

```bash
npm install                       # installs server/ and sdk/ (npm workspaces)
cd server && npx prisma generate
cd .. && npm test                 # 188 server tests, 12 SDK tests
```

The app is not part of the workspace — it has its own dependencies and its own
87 tests:

```bash
cd app && npm install && npm test
```

Run the server against a local SQLite file:

```bash
cd server
DATABASE_URL="file:./dev.db" npx prisma db push
DATABASE_URL="file:./dev.db" \
PORT=4890 \
PUBLIC_BASE_URL="http://localhost:4890" \
ADMIN_API_KEY="pick-something" \
EXPO_PUSH_DISABLED=true \
npx tsx src/index.ts

curl -s http://localhost:4890/health
# {"status":"ok","database":"up"}
```

The app, a real phone, a camera, a fingerprint and a push notification are a
separate exercise: [TESTING.md](TESTING.md) walks through it end to end. To
exercise the protocol without a phone, `server/scripts/protocol-check.mjs`
plays one over HTTP with generated keys.

## Adding it to your own product

Seven steps, in the order you will do them. Every response below came from a
local server running this code, with ids shortened to fit.

**1. Create a tenant.** One per brand. Needs the server's `ADMIN_API_KEY`; the
API key and webhook secret come back once and are never shown again.

```bash
curl -s -X POST http://localhost:4890/v1/tenants \
  -H "authorization: Bearer $ADMIN_API_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"Acme Automation","brandName":"Acme","brandColor":"#5B8CFF",
       "webhookUrl":"https://acme.example.com/approvals/decision"}'
```

```json
{
  "tenant": { "id": "ten_a847…", "brandName": "Acme", "deviceCap": 5,
              "requestTtlSec": 600 },
  "apiKey": "aa_live_<shown once — store it now>",
  "webhookSecret": "<shown once — store it now>"
}
```

**2. Create a subject.** A subject is one of your accounts. `externalId` is
your own id for it, and it is the only identifier you ever send again.

```bash
curl -s -X PUT http://localhost:4890/v1/tenants/me/subjects \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"externalId":"cus_1842","label":"Dr Patel, Riverside Clinic"}'
```

**3. Pair a phone.** Your portal calls this and renders `qrPayload` as a QR
code — and as text underneath, for a phone whose camera will not focus. The
payload carries a single-use secret that expires in five minutes.

```bash
curl -s -X POST http://localhost:4890/v1/pairings \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"externalId":"cus_1842","label":"Dr Patel, Riverside Clinic"}'
```

```json
{
  "pairing": { "id": "pair_3abd…", "expiresAt": "2026-09-20T21:33:31.867Z" },
  "qrPayload": {
    "v": 1,
    "serverUrl": "https://approvals.acme.example.com",
    "secret": "JPKiIFtyiTFPBepD7tLF1j8Nv4QlygWG3seA8lR-pL4",
    "tenantId": "ten_a847…",
    "brand": { "name": "Acme", "logoUrl": null, "color": "#5B8CFF" },
    "subject": { "label": "Dr Patel, Riverside Clinic" }
  }
}
```

Poll `GET /v1/pairings/:id` while the code is on screen, so the page can move
on the moment the phone has used it.

**4. Ask whether a call needs approval.** This is the question your gateway
asks before every tool call: one HTTP call, one database round trip.

```bash
curl -s -X POST http://localhost:4890/v1/policies/evaluate \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"externalId":"cus_1842","resourceKey":"gmail/GMAIL_SEND_EMAIL"}'
```

```json
{ "gated": true, "reason": "customer", "matchedKey": "gmail/GMAIL_SEND_EMAIL" }
```

`gated: false` means run the call and forget AgentAction was here. Nothing is
gated until somebody turns it on, so a customer who has never heard of this
feature notices no change.

**5. Park the call.** Keep the arguments. Send the display payload and the
hash.

```bash
curl -s -X POST http://localhost:4890/v1/requests \
  -H "authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"externalId":"cus_1842",
       "actorLabel":"Claude Code",
       "resourceKey":"gmail/GMAIL_SEND_EMAIL",
       "title":"Send email via Gmail",
       "fields":[{"label":"To","value":"patient@example.com"},
                 {"label":"Subject","value":"Your appointment"}],
       "argsHash":"a15a264f0308701211a1a29553e213c2b9474e302d91c279bb3a47f2550d261a"}'
```

```json
{
  "request": { "id": "req_33bb…", "code": "1940", "status": "pending",
               "expiresAt": "2026-09-20T21:38:51.318Z" }
}
```

Hand the agent that 4-digit code straight away, along with "waiting for
approval". The same code is on the phone, so the person can see the two match.

`title` becomes the push notification body, which is readable on a locked
phone — so keep argument values out of it. They belong in `fields`, which the
app fetches only after the phone is unlocked.

`argsHash` is SHA-256 over canonical JSON — keys sorted at every level, so the
same arguments always hash the same whatever order your code built them in. The
SDK computes it for you:

```ts
import { hashArgs } from '@agentaction/sdk';

hashArgs({ to: 'patient@example.com', subject: 'Your appointment', body: 'Tuesday at 3pm.' });
// 'a15a264f0308701211a1a29553e213c2b9474e302d91c279bb3a47f2550d261a'
```

An identical call that is already waiting reuses the open request and answers
`deduplicated: true`, so a retrying agent does not put a second notification on
the phone.

**6. Receive the decision.** AgentAction posts your `webhookUrl` and signs the
body with the tenant's webhook secret.

```
POST /approvals/decision
x-agentaction-signature: t=1789939765,v1=12bb9afc7e562c4db933dc3712079…

{"type":"request.decided","requestId":"req_65c5…","subjectExternalId":"cus_1842",
 "resourceKey":"gmail/GMAIL_SEND_EMAIL","status":"approved","decisionScope":"once",
 "decisionWindowSec":null,"argsHash":"a15a264f…","decidedAt":"2026-09-20T21:29:22.784Z"}
```

Verify it against the **raw** body before you trust a word of it:

```ts
import { parseWebhook } from '@agentaction/sdk';
const event = parseWebhook(process.env.WEBHOOK_SECRET!, req.header('x-agentaction-signature'), rawBody);
```

Do not make the webhook your only path. Reconcile: anything still `pending` a
little while later can be read with `GET /v1/requests/:id`, or waited on with
`GET /v1/requests/:id/wait?timeout=30`, which holds the connection until the
status changes. A lost webhook then costs a minute, not the action.

**7. Run it — once.** Check that `argsHash` in the webhook still matches the
arguments you parked, re-check whatever you would normally check (the token is
still valid, the scope still covers it, the customer can still pay for it), and
execute. `decisionScope: "window"` means the person also said "and don't ask
again for a while", so the next identical call comes back ungated with
`reason: "grant"`. `decisionWindowSec` says for how long: the person picks 5
minutes, 15 minutes, 1 hour or 8 hours on their phone, and the agency's own
ceiling (`maxGrantWindowSec`, an hour unless it says otherwise) may shorten
it. A bank can cap every customer at five minutes, or at nothing.

If AgentAction is unreachable while a rule is on, **fail closed**: refuse the
tool call. An approval step that disappears under load is not an approval step.
The SDK marks that case for you — `AgentActionError.unavailable`.

## Security

- **Two keys per phone, both Ed25519.** One signs the app's own API calls, so
  there is no bearer token on the device to steal. The other signs decisions
  and is stored with `requireAuthentication`, so the operating system releases
  it only after Face ID or a fingerprint. The server stores public halves only.
- **The signature covers the arguments.** A decision signs
  `agentaction.decision.v2 | requestId | approved/denied | once/window |
  windowSec | argsHash | signedAt`, using the hash the *server* holds, not one
  the caller supplied. A decision cannot be replayed onto a different call, and
  nobody can swap the arguments between the screen and the execution.
- **The signature covers how long it lasts.** `windowSec` is inside the signed
  message, so a five-minute approval cannot be turned into an eight-hour one
  in flight. `once` signs a literal `0` rather than omitting the field, so
  there is one message shape and nothing to guess. The server accepts the four
  offered durations and refuses any other value outright.
- **Signed calls expire.** Device signatures and decisions are refused outside
  a 120-second window by default (`SIGNATURE_SKEW_SEC`).
- **Webhooks are HMAC-signed** over the exact bytes sent, with a timestamp and
  a 5-minute tolerance, compared in constant time.
- **Secrets are stored as hashes.** Integrator API keys and pairing secrets are
  kept as SHA-256; the plaintext exists once, in the response that creates it.
- **Revoking is immediate and one-way.** A revoked phone cannot decide anything
  and stops being notified from that moment.
- **First decision wins**, enforced by a conditional update, so two people
  answering at the same instant cannot both approve.

**What the server deliberately never sees.** It gets a title, a list of
labelled display fields, and a hash. It never receives the real arguments, so
it cannot run the action, and a breach of the approval server does not hand
anyone the contents of your customers' tool calls. Push notifications carry the
brand, the action label and the code — never a field value, because a
notification is readable on a locked phone.

The app renders every field as plain text, never as markup, and labels it as
written by the agent. Those arguments may well have been composed by something
the agent read on the internet.

## Status and limitations

This is Phase 1. It is honest work, well tested, and not yet battle-worn.

- 331 automated tests: 211 for the server (including every endpoint through
  supertest), 17 for the SDK, 103 for the app.
- **Proven end to end on real hardware.** An Android phone paired against a
  live server; an agent's email-sending tool call was parked by a real gateway;
  the phone showed it, it was approved with a fingerprint, and the gateway sent
  the email once and handed the result back to the waiting agent — about 20
  seconds from request to result, including the time taken to approve. iOS has not yet been run on a device, and
  push notifications have not yet been seen arriving on one (the app shows
  waiting requests when opened). The walkthrough is in [TESTING.md](TESTING.md).
- **Production-ready packaging.** A Docker image, Postgres (including
  Supabase), and any number of instances behind a load balancer — see
  [docs/production.md](docs/production.md).
- **Many organisations on one server.** One tenant per organisation, created
  by the operator — see [docs/multi-tenancy.md](docs/multi-tenancy.md). Key
  rotation without re-provisioning is not built yet.
- **iOS needs one interactive build.** Apple requires a signed provisioning
  profile naming each device, and EAS has to log in to create it.
- **No rate limiting in the server.** Put it behind something that has some.
- **The approval key lives in the platform keychain**, biometric-gated, rather
  than signing inside the secure element. Hardware-backed signing is a Phase 2
  hardening item.
- **Push receipts are not polled yet.** A dead token is retired when the push
  service says so on the ticket; the verdicts that arrive minutes later are not
  yet collected.
- No approver roles or quorum: anyone who has paired a phone to an account can
  decide for it, up to five phones.

## Editions

**Community** — this repository, Apache-2.0: the server, the SDK and the phone
app, with nothing withheld or time-limited. Self-host it for your own
organisation.

**Enterprise** — running AgentAction for **many organisations on one server**
(multi-tenancy: a tenant per organisation, each with its own brand, rules,
people, phones and webhook), with Kno2gether Labs behind it: onboarding, an SLA,
and help designing the isolation for your platform. A hosted cloud edition, so
you run no server at all, is planned and will be described here when it exists.
See [docs/multi-tenancy.md](docs/multi-tenancy.md).

To be plain about what that label means: the multi-tenant code is in this
repository under Apache-2.0 like everything else, and you may run it. Enterprise
is the support, hosting and expertise around it, not a licence to use it.

Neither edition gates notifications. A self-hosted server can push to the
published app on its own — Expo accepts a send to a push token without any
credential of ours, which we checked rather than assumed. What a company does
need its own Apple and Google accounts for is a *branded* app under its own name
in the stores; the protocol is identical either way.

## Who builds this

AgentAction is a product of **Kno2gether Labs LTD**, which owns the copyright,
the name and the mark. It came out of building agent systems that needed a
human in front of the dangerous calls.

If you would rather have it deployed, integrated and operated for you — or want
the same review applied to the agents you already run — that work is delivered
by [Sonti](https://sonti.io), an AI engineering agency we work with. Book a
conversation there; the product itself stays with Kno2gether Labs.

## Licence

[Apache-2.0](LICENSE). Run it, change it, use it commercially, including inside
your own product — no fee, no separate agreement.

The server, the SDK and the phone app are all Apache-2.0. [NOTICE](NOTICE)
says plainly what that covers and what it does not. In short: all of the code
here, including multi-tenancy, is yours to run, so you may run as many tenants
as you like on your own installation. What is sold separately is the Enterprise
support and the hosted service around it, and the licence does not grant the
AgentAction name and mark.

## Getting help

Open an issue with the version, the endpoint and the error code from the
response body — every failure returns `{"error":{"code":…,"message":…}}`, and
the code is the useful part. If it involves a phone, say which platform and
whether the build was `preview` or from a store.

If you are reporting something security-sensitive, say so in the first line and
do not include real arguments, tokens or customer data.

Running it in production: [docs/production.md](docs/production.md). Many
organisations on one server: [docs/multi-tenancy.md](docs/multi-tenancy.md).
The device test plan: [TESTING.md](TESTING.md).
