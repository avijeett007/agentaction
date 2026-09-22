# Running AgentAction in production

Written for whoever deploys and operates the approval server. What the server
does, and every endpoint it serves, is in [server/README.md](../server/README.md).

## What you run

| Piece | What it is | State |
|---|---|---|
| **Approval server** | One Node.js process per container, from [`server/Dockerfile`](../server/Dockerfile) | None in the process — everything is in Postgres |
| **PostgreSQL** | Tenants, end users, phones, rules, approval requests, webhook deliveries, audit trail | The only state. Back it up. |
| **The phone app** | The published AgentAction app, or your own build of [`app/`](../app) | Keys stay on the phone |
| **Your integration** | Your service, using [`@agentaction/sdk`](../sdk) to gate risky actions | Holds the real tool arguments — the server never sees them |

There is no Redis, no queue and no worker. The server needs:

- **Inbound HTTPS** from phones on mobile networks and from your integration.
- **Outbound HTTPS** to Expo's push service (`exp.host`) and to your webhook
  receivers.

## The database

Any PostgreSQL 13 or later works. It has been tested on 16. Give AgentAction
**its own database**, even if it shares a server with something else, so it can
be backed up, restored and moved on its own. It stays small: rows are a few
hundred bytes, and it never holds tool arguments, only a title, display fields
and a hash.

### Supabase

Supabase is a good fit. It is plain Postgres, and the server uses no
transactions or raw SQL, so its connection pooler works unchanged. Two things to
get right:

- **Use the pooler address, not the direct one.** Direct connections to a
  Supabase database are IPv6 only, unless you buy the IPv4 add-on. Many
  container hosts cannot reach IPv6. The pooler (`*.pooler.supabase.com`)
  answers on IPv4.
- **Use two connection strings.** Take both from *Connect* in the Supabase
  dashboard:

  | Used for | Pooler mode | Port | Add to the URL |
  |---|---|---|---|
  | The running server (`DATABASE_URL`) | Transaction | 6543 | `?pgbouncer=true&connection_limit=5` |
  | `npm run db:deploy`, once per release | Session | 5432 | nothing |

  `pgbouncer=true` stops Prisma using prepared statements, which a
  transaction-mode pooler cannot carry. `connection_limit` caps each
  container's pool; see [Several instances](#several-instances).

Free Supabase projects pause when idle. A paused database is an outage here —
see [When the server is down](#when-the-server-is-down) — so production wants a
paid project. Point-in-time recovery comes with the paid plans and is the
simplest backup story.

### Coolify's own Postgres, or any other

Create a PostgreSQL resource, create a database and a user for AgentAction, and
use the internal connection URL as `DATABASE_URL`. There is no pooler to think
about. Set `?connection_limit=` if you run many containers. Turn on scheduled
backups for the resource.

## Build the image

From the repository root, because the npm workspace lockfile lives there:

```bash
docker build -f server/Dockerfile -t agentaction-server .
```

The image runs on Postgres only. It contains the compiled server, production
dependencies and the Postgres schema, and runs as the unprivileged `node` user
with a Docker health check on `/health`.

## Deploy on Coolify

1. **New resource → Public/Private Repository → Dockerfile.** Base directory
   `/`, Dockerfile location `/server/Dockerfile`.
2. **Port** `4890`. **Domain**: the HTTPS address phones will use, for example
   `https://approvals.example.com`. Coolify's proxy terminates TLS.
3. **Environment**: see the table below. At least `DATABASE_URL`,
   `PUBLIC_BASE_URL` (the same address as the domain) and `ADMIN_API_KEY`.
4. **Health check**: path `/health`. It returns
   `{"status":"ok","database":"up"}` only when Postgres answers.
5. **Create the tables** before the first start. Either set Coolify's
   *pre-deployment command* to `npm run db:deploy`, or run that once from the
   container's terminal. On Supabase, point it at the session-mode URL (see
   above) by prefixing `DATABASE_URL=… ` to the command.
6. Deploy. Then create your first tenant — see
   [Creating tenants](#creating-tenants).

Anything else that runs a container works the same way: Fly.io, ECS, Cloud
Run, Kubernetes, or plain `docker run`.

## Environment

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | yes | The Postgres connection string. On Supabase, the transaction-pooler URL with `?pgbouncer=true`. |
| `PUBLIC_BASE_URL` | yes | The HTTPS address phones reach this server on. It is put into every pairing QR code: a wrong value pairs phones that can never call home. |
| `ADMIN_API_KEY` | to create tenants | Guards `POST /v1/tenants`. Long and random (`openssl rand -hex 32`). Unset refuses all tenant creation, which is the right setting once a single-organisation deployment is set up. |
| `PORT` | no | Defaults to `4890`. |
| `LOG_LEVEL` | no | `info` by default. One JSON object per line on stdout/stderr — ship it to your log store. |
| `EXPO_ACCESS_TOKEN` | no | Needed only if your Expo account has *enhanced push security* turned on. |
| `EXPO_PUSH_DISABLED` | no | `true` sends no notifications at all. Never set it in production. |
| `PAIRING_TTL_SEC` | no | How long a pairing code is valid. Default 300. |
| `SIGNATURE_SKEW_SEC` | no | Allowed clock difference on phone signatures. Default 120. |

## Several instances

Supported. Run as many containers as you like against one database, behind any
load balancer, **with no sticky sessions**:

- A long poll (`GET /v1/requests/:id/wait`) re-reads the database, so it sees a
  decision recorded by any instance.
- Decisions and expiry are conditional updates, so the first answer wins no
  matter which instance takes it.
- Phone signatures are checked statelessly.
- Each instance runs the webhook sweep, but a delivery is claimed atomically
  before it is sent, so it goes out once. If an instance dies mid-send, the
  claim lapses after 60 seconds and another instance retries it.

Three things to size:

- **Connections.** Each container opens its own Prisma pool. Keep
  *containers × `connection_limit`* under what the database or pooler allows.
- **Long polls.** Each waiting agent holds a connection to the server for up
  to 50 seconds and re-reads one row every 500 ms. Set proxy and load-balancer
  idle timeouts above 60 seconds.
- **Migrations.** Run `npm run db:deploy` **once** per release, before the new
  containers start — never from every container at boot.

## Creating tenants

A tenant is one organisation: its brand on the phone, its rules, its end users
and phones, its webhook. Create one with the operator key:

```ts
import { AgentActionOperator } from '@agentaction/sdk';

const operator = new AgentActionOperator({
  baseUrl: 'https://approvals.example.com',
  adminApiKey: process.env.AGENTACTION_ADMIN_API_KEY!,
});
const { tenant, apiKey, webhookSecret } = await operator.createTenant({
  name: 'Example Ltd',
  brandName: 'Example',
  webhookUrl: 'https://api.example.com/agentaction/decision',
});
```

`apiKey` and `webhookSecret` are returned **once**. The server keeps only a
hash of the key and has no endpoint to read either again. Store both in your
secret manager before doing anything else.

One organisation? Create its tenant, save the key, then unset
`ADMIN_API_KEY` so nothing can create another. Many organisations? Keep the
key, create a tenant per organisation, and read
[multi-tenancy.md](multi-tenancy.md).

## Upgrading

1. Build the new image.
2. Run `npm run db:deploy` from it once. It uses `prisma db push`, which
   **refuses** any change that would lose data and says why. Never add
   `--accept-data-loss` against production; stop and read the release notes
   instead.
3. Replace the containers. Old and new can overlap during a rolling deploy.

## Backups

The database holds pairings, devices, rules, requests and the audit trail.
Losing it means every end user pairs their phone again and every rule is
recreated. It holds no tool arguments and no private keys: phones keep their
keys, and tenant API keys are stored hashed.

Take daily backups at least, keep a week, and **restore one into a scratch
database once** before you rely on it. On Supabase, point-in-time recovery
covers this. On Coolify, use the Postgres resource's scheduled backups to S3.

## When the server is down

An integration using the SDK is expected to **refuse** a risky action when it
cannot reach the server (`AgentActionError.unavailable`). Refusing is safer than
letting the action through unapproved. So downtime here means agents cannot take
the actions you gated. Plan uptime accordingly:

- Run at least two instances.
- Monitor `/health` from outside, not only from the container.
- Keep the database on a plan that does not pause.

## Worth an alert

- `/health` failing from outside.
- Webhook deliveries reaching `failed`: a receiver is down or rejecting
  signatures. Integrators that also poll keep working, but slower.
- Requests expiring without an answer, climbing: notifications are not
  reaching people, or they are being asked too often.
- A burst of `401 bad_signature` on device routes: a phone with a wrong clock,
  or someone replaying traffic.

## Security checklist

- HTTPS only. Phones refuse plain HTTP to anything but a local network address.
- `ADMIN_API_KEY` long, random, in a secret store, and unset when not needed.
- The database not reachable from the internet, or limited to your hosts'
  addresses.
- Tenant API keys and webhook secrets kept in a secret manager, never in a
  repository.
- Webhook receivers verify the `x-agentaction-signature` header over the raw
  body (`verifyWebhook` in the SDK) and check that the request belongs to the
  tenant they think it does.
