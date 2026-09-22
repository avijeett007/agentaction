# Multi-tenancy — one server, many organisations

> **Enterprise feature.** Running one AgentAction server for many organisations
> is what the AgentAction Enterprise plan covers. The code for it is in this
> repository under Apache-2.0, like everything else, and you are free to run it.
> What Enterprise adds is Kno2gether Labs standing behind it: the hosted
> service, onboarding, an SLA, and help designing the isolation for your
> platform. Deployment and integration work is delivered by
> [Sonti](https://sonti.io).

This is for platforms whose customers are organisations: an agency running AI
agents for its clients, or a SaaS whose tenants each connect their own tools.
Each organisation needs its own brand on the phone, its own rules, its own
people and phones, and its own webhook. AgentAction's unit for that is the
**tenant**.

If you only ever protect your own organisation, you need one tenant and none of
this. See [production.md](production.md#creating-tenants).

## The model

| Server concept | Means | Scoped by |
|---|---|---|
| Tenant | One organisation: brand name, logo, colour, webhook URL, device cap, request lifetime, longest approval window | Its API key |
| Subject | One end user within it, keyed by your own `externalId` | Tenant |
| Device | A paired phone, up to the tenant's cap per subject | Subject |
| Tenant policy | The organisation's default for a tool, optionally **locked** so its users cannot switch it off | Tenant |
| Subject policy | One user's own choice for a tool | Subject |
| Request | One parked action waiting for a decision | Subject |

The server enforces the boundary. Every integrator call is authenticated by a
tenant API key and sees only that tenant's rows. A subject, request, device or
policy that belongs to another tenant is answered `404`, as if it did not exist.
Pairing codes, push notifications and the brand shown on the phone all come
from the tenant that created them.

## Provisioning a tenant per organisation

Use `AgentActionOperator` from the SDK with the server's `ADMIN_API_KEY`. The
pattern that holds up in production:

1. **Create on demand, when an organisation's admin switches approvals on.**
   Not at signup: most organisations may never use it, and the operator key
   should be spent deliberately.
2. **Claim before you create.** Insert a row keyed by your organisation id
   under a unique constraint, *then* call `createTenant`. Two concurrent clicks
   then make one tenant, not two.
3. **Store `apiKey` and `webhookSecret` encrypted, immediately.** They are
   returned once. The server keeps only a hash of the key, and has no endpoint
   to read either again. Lose them and the organisation must be provisioned
   afresh: every phone re-pairs and every rule is set up again.
4. **Give each organisation its own webhook URL** with your organisation id in
   the path, for example `https://api.example.com/agentaction/decision/<orgId>`.
5. **Keep the brand in step.** Call `updateTenant({ brandName, brandLogoUrl,
   brandColor })` whenever the organisation changes its branding, so the name
   on the phone and the name your agent tells users to look for are the same.
6. **Only an organisation admin can trigger this**, from your backend. The
   operator key must never be reachable by an end user, or by one
   organisation acting on another.

## Receiving decisions

The organisation id in the webhook path is only a **hint**: it tells you which
stored secret to verify with. Then:

1. Verify `x-agentaction-signature` over the raw body with *that*
   organisation's webhook secret (`verifyWebhook` in the SDK). If there is no
   such organisation, answer exactly as you would for a bad signature.
2. Look up the parked action by `requestId` in your own records, and check it
   belongs to the organisation in the path. If it does not, refuse. Otherwise a
   validly signed decision from one organisation could release another's
   action.
3. Make acting on it idempotent. The same decision can arrive more than once,
   and your reconciliation poll may have seen it first.

## Using the right credentials on every call

Resolve the organisation's tenant client per request, from the organisation
that owns the action — never from anything the caller supplies. If you cache
clients, key the cache by organisation id **and** a fingerprint of the stored
credentials, so a re-provisioned tenant takes effect at once. Never share one
client between organisations.

## Deciding what happens when something is missing

Decide this per organisation, and write it down:

| Situation | Recommended behaviour |
|---|---|
| The organisation never switched approvals on (no tenant) | Its actions run as they always did. |
| It has a tenant, but its stored credentials cannot be read (decryption error, your own database unreadable) | **Refuse** gated actions. An unreadable credential is not evidence that nothing needs approving. |
| The approval server cannot be reached | **Refuse** (`AgentActionError.unavailable`). |
| The organisation's tenant was disabled | Treat as "never switched on". Say so in its admin UI. |

## Locked rules

A tenant policy with `locked: true` wins over whatever a user chose, in both
directions. An organisation can therefore require approval for, say, every
payment, and its users cannot switch that off. In a platform, give the
organisation's admin — not your own staff — the controls that set tenant
policies. `setTenantPolicy` and `listTenantPolicies` in the SDK are the calls.

## Capacity

One server comfortably holds many tenants: they share tables, and every query
is indexed by tenant or subject. Scale by adding instances — see
[production.md](production.md#several-instances) — not by giving each
organisation its own server.

## Not built yet

- Rotating a tenant's API key or webhook secret without re-provisioning.
- Per-tenant quotas and usage reporting.
- An operator console. Today the operator works through the API and the
  database.
- An organisation bringing its own approval server while staying on your
  platform.
