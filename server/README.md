# AgentAction — the approval server

The service that holds the parked approval, rings the phones, and records who
decided what.

It is an Express app with Prisma in front of SQLite (development) or Postgres
(production). It has no queue, no Redis and no background service beyond two
timers in its own process: one that retries webhooks, one that expires requests
nobody answered.

**It never executes a tool call.** It is given a title, a list of labelled
display fields and a SHA-256 hash of the arguments. The arguments themselves
stay with the integrator. That split is the point: this database can be lost,
audited or subpoenaed without exposing what anyone's agent was actually doing,
and a compromise of this server cannot run anything.

See the [repository README](../README.md) for the whole picture, and
[TESTING.md](../TESTING.md) for driving it from a real phone.

## The data model

`prisma/schema.prisma` is the source of truth. Every model is portable between
SQLite and Postgres — no native enums, no scalar lists, no Postgres-only types
— so the two databases stay one schema.

| Model | What it holds |
|---|---|
| `Tenant` | One integrator brand: name, logo, colour, the SHA-256 of its API key, its webhook secret and URL, its device cap (1–5) and default request lifetime. |
| `Subject` | One of the integrator's accounts, identified by their own `externalId`, unique within the tenant. |
| `Device` | A paired phone: two Ed25519 public keys (one for API calls, one for decisions), the Expo push token, label, platform, and when it was revoked or last seen. |
| `PairingCode` | A single-use pairing secret, stored as a hash, with a five-minute expiry and the moment it was used. |
| `ApprovalRequest` | One parked call: who asked, the resource key, the title, the display fields as JSON, the argument hash, a 4-digit code, status, expiry and the decision scope. |
| `Decision` | The signed answer from one device. Unique per request — the first decision wins. |
| `Policy` | Which tools need approval. `subjectId = null` is the agency's row (its default, and whether it is locked); a row with a `subjectId` is that customer's own choice. |
| `Grant` | "Allow this tool without asking for a while", created by approving with scope `window`. |
| `WebhookDelivery` | Each outbound decision webhook with its attempts, last error and next retry. |
| `AuditEvent` | Append-only: pairings, requests, decisions, policy changes. |

Statuses are plain strings so both databases agree on them:
`ApprovalRequest.status` is `pending | approved | denied | expired`,
`Decision.decision` is `approved | denied`, and the scope is `once | window`.

## The endpoints

Every error, at every path, is
`{"error":{"code":"…","message":"…","details":…}}`. The code is the part worth
branching on.

### Public

| Endpoint | What it does |
|---|---|
| `GET /health` | `{"status":"ok","database":"up"}`, or 503 with `degraded` when the database is not answering. |

### Called by the operator

| Endpoint | What it does |
|---|---|
| `POST /v1/tenants` | Create a brand. Authenticated with `ADMIN_API_KEY`, not a tenant key. Returns the API key and the webhook secret **once**. If `ADMIN_API_KEY` is unset, this is refused with `admin_key_unset`, which is the right setting for a deployment that is finished provisioning. |

### Called by the integrator (`authorization: Bearer aa_live_…`)

| Endpoint | What it does |
|---|---|
| `GET /v1/tenants/me` | What this API key belongs to. |
| `PATCH /v1/tenants/me` | Branding, webhook URL, device cap, default request lifetime. |
| `PUT /v1/tenants/me/subjects` | Create or update one account. Idempotent on `externalId`. |
| `GET /v1/tenants/me/subjects/:externalId` | One account and how many live devices it has. |
| `POST /v1/pairings` | Mint the payload the portal renders as a QR code. Upserts the subject on the way through, so "add a phone" is one call. |
| `GET /v1/pairings/:id` | `pending`, `used` or `expired` — poll it while the code is on screen. |
| `GET /v1/devices?externalId=…` | The phones on one account. Push tokens never leave the server; each row carries `pushEnabled` instead. |
| `DELETE /v1/devices/:id` | Revoke a phone the customer has lost. One-way and idempotent. |
| `POST /v1/requests` | Park one call and notify the phones. An identical call already waiting is reused and answered with `deduplicated: true`. |
| `GET /v1/requests/:id` | Where that call has got to. Expires it on the way past if its time is up. |
| `GET /v1/requests/:id/wait?timeout=30` | The same, but holds the connection until the status changes. Capped at 50 seconds. |
| `POST /v1/policies/evaluate` | The question to ask before every tool call: `{gated, reason, matchedKey}`. A subject we have never heard of is never gated. |
| `GET /v1/policies?externalId=…` | Every rule touching one customer, with the effective answer and where it came from. |
| `PUT /v1/policies/subject` | The customer's own answer for one tool. |
| `DELETE /v1/policies/subject` | Forget it, so the agency default applies again. |
| `GET /v1/policies/tenant` | The agency's own rows. |
| `PUT /v1/policies/tenant` | Set an agency default, optionally `locked` so the customer cannot switch it off. |

A resource key is `<app>/<tool>` or `<app>/*`, and it is canonicalised on the
way in — lowercase app, uppercase tool. Rules are written by one surface (a
portal) and read by another (a gateway); if the two spelt the key differently,
the rule would save, show as on, and gate nothing.

Precedence, in order: a live grant, then a locked agency rule, then the
customer's rule, then the agency default, then nothing. An exact key beats an
`app/*` wildcard at the same level. Silence never blocks a call.

### Called by the phone (`x-aa-device`, `x-aa-timestamp`, `x-aa-signature`)

There is no bearer token on the device. Each call is signed by the device key
over `METHOD\npath\ntimestamp\nsha256(body)`, and a signature more than
`SIGNATURE_SKEW_SEC` old is refused.

| Endpoint | What it does |
|---|---|
| `POST /v1/devices/register` | Redeem a pairing secret and register both public keys. Deliberately unauthenticated: the secret from the QR code is the credential, and the app has no identity until this succeeds. Every other phone on the account is notified that a new one appeared. |
| `PATCH /v1/devices/me` | Rename this phone, or refresh (or clear) its push token. |
| `DELETE /v1/devices/me` | Unpair this phone from Settings. |
| `GET /v1/device/requests` | What this phone is being asked to decide. Carries no argument values — only titles. |
| `GET /v1/device/requests/:id` | One request with its display fields, for the approval screen. |
| `POST /v1/device/requests/:id/decision` | Approve or deny. Signed by the *approval* key, over the argument hash this server holds, so the decision cannot be moved to another call. |

## Running it locally

```bash
npm install                # from the repository root; server/ is a workspace
cd server
npx prisma generate
DATABASE_URL="file:./dev.db" npx prisma db push

DATABASE_URL="file:./dev.db" \
PORT=4890 \
PUBLIC_BASE_URL="http://localhost:4890" \
ADMIN_API_KEY="pick-something" \
EXPO_PUSH_DISABLED=true \
npx tsx src/index.ts
```

Nothing loads `.env` into the server for you. The Prisma CLI reads it, the
server process does not: there is no `dotenv` here, so what it sees is what the
host gave it. In development, hand the file to Node yourself (20.6 or newer):

```bash
cp .env.example .env
npx tsx watch --env-file=.env src/index.ts
```

`npm run dev` is the same thing without the `--env-file`, for when the
variables are already exported.

SQLite paths are relative to `prisma/`, not to the working directory:
`file:./dev.db` lands in `server/prisma/dev.db`. An absolute path avoids the
question.

Tests rebuild their own database from the schema before each run:

```bash
npm test                   # 188 tests, single worker, its own prisma/test.db
npm run typecheck
```

To exercise the phone protocol without a phone — register keys, list, open,
sign an approval, and have a deliberately mismatched signature refused:

```bash
BASE=http://localhost:4890 API_KEY=aa_live_… SECRET=<a fresh pairing secret> \
  node scripts/protocol-check.mjs
```

It registers itself against the subject in `SUBJECT` (default `customer-1`), so mint the pairing
code for that account.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `DATABASE_URL` | — | `file:./dev.db` for SQLite, a `postgresql://` URL in production. Required. |
| `PORT` | `4890` | |
| `PUBLIC_BASE_URL` | `http://localhost:4890` | The URL phones dial back on. It is baked into the pairing QR payload, so a wrong value here pairs phones that can never call home. |
| `ADMIN_API_KEY` | unset | Guards `POST /v1/tenants` only. Unset means tenant provisioning is refused outright. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`. Logs are one JSON object per line, on stdout and stderr. |
| `NODE_ENV` | `development` | |
| `EXPO_ACCESS_TOKEN` | unset | Optional. Expo accepts unauthenticated sends; the token buys enhanced security, not the ability to send. Create one at expo.dev → Account settings → Access tokens. |
| `EXPO_PUSH_DISABLED` | `false` | Set `true` to send nothing at all. Local development and the test suite do. **Push is on by default**: an approval product that silently notifies nobody is the one failure it cannot afford. |
| `PAIRING_TTL_SEC` | `300` | How long a pairing code is valid. |
| `SIGNATURE_SKEW_SEC` | `120` | Allowed clock skew on device signatures and signed decisions. |
| `GRANT_WINDOW_SEC` | `900` | How long an "approve for a while" grant lasts. The server's number, never the caller's. |

Some bounds are fixed in code rather than configured, because a careless value
would quietly disable the protection: a request lifetime is clamped to 300–3600
seconds whatever a tenant asks for, and no tenant may raise its device cap
above five.

Anything non-numeric or negative in the numeric variables falls back to the
default rather than failing to boot.

## SQLite for development, Postgres for production

One schema, two datasources. `prisma/schema.prisma` declares `sqlite`;
`npm run db:postgres` writes `prisma/schema.postgres.prisma` with the provider
swapped and everything else untouched. Keep the models portable and the two
never drift.

In production, point every Prisma command at the generated file:

```bash
npm run db:postgres
npx prisma generate --schema=prisma/schema.postgres.prisma
npx prisma db push  --schema=prisma/schema.postgres.prisma
npm run build && npm start
```

The client is generated from whichever schema you last named, so the
`generate` step is not optional: a build carrying the SQLite client will not
talk to Postgres.

`db push` is used rather than migrations: the schema is young and every change
so far has been additive. That will want revisiting before this is running for
other people's customers.

The database holds pairings, devices, policies and the audit trail. Losing it
means every customer pairs again and every rule is gone, so back it up with the
same care as the database it sits beside. It holds no tool arguments.
