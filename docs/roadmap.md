# AgentAction roadmap

Written for the people deciding what AgentAction builds next: the owner, early
partners and anyone evaluating it for an organisation. Each item says what it
means, whether it is feasible, how we would build it and roughly what it costs.
Effort is in engineer-weeks. Nothing below is built yet unless it says so.

**The vision.** AgentAction puts a person in charge of the actions that
automated systems take — AI agents today, and any automation that calls an API
or an MCP service, as agents keep getting more capable. The goal is that any
API or MCP service can require an approval from the person accountable for it,
on their phone, without the caller or the service being rewritten. AI agents
are the first callers; they will not be the last.

Where this starts from (September 2026): an approval server, a TypeScript SDK
and a phone app. Integrators authenticate with one API key per tenant; phones
pair by QR code; approvals are signed on the phone over a hash of the exact
arguments; rules are static (per tool, per person, with organisation locks)
plus timed "approve for longer" windows.

---

## Phase 0 — tighten what exists (1–2 weeks)

Found while researching the items below. They come first because later phases
build on them.

- **Decide whether "approve for longer" may bypass a locked rule.** Today a
  live window is checked before a lock, so a person can wave through, for an
  hour, an action their organisation locked on — unless the organisation sets
  the window limit to zero. The safer default is that windows never cover
  locked rules unless the organisation opts in per rule.
- **Optionally scope windows to the exact arguments**, or to the same
  recipient, as well as the current "same tool" scope.
- **Make the audit trail tamper-evident.** Write the audit record in the same
  transaction as the decision, and chain the records by hash.
- **Show "unverified" next to the agent's name on the phone** until agent
  identity (Phase 4) exists — today the name is free text from the integrator.
- **Small app fixes:** tapping a notification should open that request; the
  settings screen should not say the key is in "secure hardware" (it is in the
  keychain/keystore); the request screen's "check the code" line should also
  cover agents that work in the background with no chat to compare against.

---

## 1. Standards-based CIBA, so any identity provider can use it

**Verdict: feasible, with one caveat.** "Any identity provider" is realistic
for *who the person is* (standard OpenID Connect, with SAML through a broker).
It is not realistic for *routing the approval through the identity provider*:
few support CIBA, and fewer let an outside app be the approving device.

**Recommended design — AgentAction becomes a CIBA provider itself.**

- Publish OpenID discovery and keys, a `/bc-authorize` endpoint and a token
  endpoint for the CIBA grant (`urn:openid:params:grant-type:ciba`), in poll
  and ping modes. Skip push mode: the FAPI-CIBA profile forbids it.
- Map today's model onto the spec: `auth_req_id` is the request id,
  `binding_message` is the 4-digit code, `requested_expiry` is the time limit,
  and the display fields plus argument hash travel as RFC 9396
  `authorization_details`.
- On approval, issue an ID token for the approver and a JWT access token that
  repeats the approved details and carries the phone's signature, so a gateway
  can check the human approval itself.
- Client authentication by `private_key_jwt` or mutual TLS, and later by
  workload identity (item 3). Signed request objects for the FAPI profile.
- Build on an existing, certified library (panva/node-oidc-provider) rather
  than writing the protocol from scratch. Whether it supports rich
  authorization details on the CIBA endpoint needs checking.
- Keep the current API as the simple path; CIBA is a second front door onto
  the same requests.

**Adapters for identity providers that already speak CIBA**, only where the
action's details can be carried through (otherwise "what you saw is what runs"
weakens to "you approved a short message"):

| Identity provider | CIBA | Can AgentAction be the approving device? |
|---|---|---|
| Keycloak | Yes (poll, ping) | Yes, through its authentication-channel extension point |
| PingFederate | Yes (poll, ping) | Yes, through its out-of-band authenticator SDK |
| Curity | Yes (poll, ping, push) | Yes, through a plugin |
| PingAM / ForgeRock | Yes (poll) | Partly, with a custom authentication node |
| Auth0 | Yes (Enterprise plan) | No — only its Guardian app or SDK |
| Okta | Yes (poll) | Only by embedding Okta's device SDK |
| Microsoft Entra ID | Not in its documented flows | No (identity only, via OpenID Connect) |

Auth0 already sells a similar flow for AI agents. AgentAction's difference:
it works with any identity provider, the approval is signed over the argument
hash, the server never holds the full arguments, and it can be self-hosted.
The IETF WIMSE group's AI-agent draft (AIMS) names CIBA as the mechanism for
human confirmation, which supports this direction.

**Effort:** CIBA provider with conformance testing, 6–8 weeks. Keycloak
adapter, 1–2 weeks. Ping or Curity adapter, 2–3 weeks each (needs their
licences to test). **Depends on** item 2, which is how a `login_hint` is
matched to a person.

**Risks:** per-organisation issuers are expensive with one provider instance;
CIBA requires `scope=openid` on something that is an approval rather than a
login (a known compromise); a `user_code` may be needed so no client can ring
someone's phone without a secret they know.

---

## 2. Sign in to the phone app with an enterprise identity provider

**Verdict: feasible.** Apple's rules allow business apps that require an
existing enterprise account without Sign in with Apple; review needs a demo
tenant.

**Recommended design:**

1. Each organisation configures its OpenID Connect issuer, allowed email
   domains (proved with a DNS record), claim mapping and required
   authentication level.
2. The person enters a work email; the server finds the organisation; the app
   opens the system browser with PKCE.
3. **The server is the OpenID client, not the phone.** The app receives a
   one-time enrolment code; no identity-provider tokens are stored on the
   phone.
4. Bind the phone's keys to the sign-in by putting a hash of the new public
   keys into the OpenID `nonce`.
5. Linked identities (issuer + subject → AgentAction person), filled by
   sign-in, SCIM or the integrator. QR pairing stays for organisations without
   single sign-on.
6. SAML through a broker (Keycloak, Authentik or Dex), never inside the app.
7. **Leavers:** a SCIM 2.0 endpoint that revokes a person's phones, cancels
   their pending requests and removes their windows when they are deprovisioned;
   later, OpenID Shared Signals (CAEP/RISC).
8. Step-up only where needed (re-authenticate every N days, or for high-risk
   tools), not on every approval — approvals must keep working when the
   identity provider is down.

**Effort:** server side 3–4 weeks, app 2–3 weeks, SCIM 2–3 weeks, Shared
Signals about 2 weeks.

**Risks:** account takeover through an unproved email domain; redirect hijack
unless universal links are used; app review needs a demo organisation.

---

## 3. Agent registration and identity, SPIFFE-based, for end-to-end audit

**Verdict: feasible, as one way to prove an agent's identity — not the only
one.**

**What AgentPass (agentpass.co.uk) does, for comparison:** a private
certificate authority issuing short-lived certificates with SPIFFE IDs to
agents, trust levels earned through behaviour, a signed-action protocol
(an individual IETF draft), behaviour monitoring, a hash-chained audit log,
and paid human approval pushed to an admin's phone for its highest trust
levels. It mostly complements AgentAction and overlaps on approvals and audit.
**Recommendation: AgentAction verifies agent identities from sources like
this rather than becoming a certificate authority.**

**Recommended design:**

1. Gateways authenticate with workload identity instead of API keys: X.509
   SVIDs over mutual TLS, or JWT SVIDs (the OAuth working group's SPIFFE
   client-authentication draft). Each organisation supplies its trust bundles.
2. The agent's own identity is forwarded in a verifiable form — a JWT SVID
   addressed to AgentAction, or an RFC 8693 token exchange with
   `sub` = the person and `act` = the agent.
3. **Agent registry per organisation:** SPIFFE ID or pattern, a human sponsor,
   purpose, allowed tools, status and review date. Rules gain an agent
   dimension; unknown agents are gated or refused, by organisation setting.
4. **Decision message v3** adds the agent's identity, so the person signs
   *which* agent they approved; the phone shows "verified agent" or
   "unverified name".
5. **End-to-end audit chain:** agent → on behalf of person → tool → argument
   hash → phone-signed approval (with the approver's identity) → an execution
   receipt signed by the gateway, stored in a hash-chained log and exportable
   to a SIEM.

**Beyond Kubernetes:** SPIFFE is awkward on laptops and impossible inside
vendors' SaaS, so also accept OpenID workload tokens (GitHub Actions, cloud
IAM, Kubernetes service accounts), vendor agent identities (for example
Microsoft Entra Agent ID) and, for laptops, a key registered after the
person's sign-in (item 2).

**Regulation this supports:** EU AI Act Article 14 (human oversight — override
and stop, awareness of automation bias), whose high-risk duties now start in
December 2027; DORA's strong-authentication and key-protection requirements
for financial customers; the UK AI Cyber Security Code of Practice
("enable human responsibility").

**Effort:** workload-identity authentication about 3 weeks; registry, rules
and decision v3, 3–4 weeks; token exchange 2–3 weeks; receipts, chained audit
and export about 3 weeks.

**Risks:** the standards are still moving; if a gateway forwards a name it did
not verify, the identity is decoration.

---

## 4. Adaptive decisioning, to reduce approval fatigue

**Verdict: feasible, with care.** Build the explainable, rule-based features
first; statistical or AI scoring comes last and should mostly *add* friction,
not remove it.

The evidence cuts both ways: people approve over 90% of routine prompts, and
over-asking is itself a recognised risk (OWASP's "overwhelming human in the
loop"); but automated classifiers still miss a meaningful share of genuinely
risky actions, so they cannot be the only control on irreversible ones.

**What the server can see today:** exact repeats (argument hash), tool,
person, time, rate, phone and decision history. Recipient and amount exist
only as display text. Full arguments never reach it — anything that needs
them runs in the gateway or SDK and reports its decision for audit.

**Mechanisms, safest first:**

1. **Rules on argument values** — ask only if the amount is over £500, or the
   recipient's domain isn't on an allow-list — with cumulative caps so £10,000
   can't be split into twenty £500 payments. Needs typed "decision features"
   per tool from the integrator.
2. **Conditional windows** — same arguments, same recipient, or at most N uses.
3. **Suggestions from history** — after several approvals with no denials, the
   phone offers "Always allow this recipient?"; the person makes the rule.
4. **Risk scoring and anomaly detection** (new recipient, burst, unusual value,
   new agent, changed tool definition) — may raise friction freely, lower it
   only within caps. Enterprise.
5. **An optional AI classifier in the gateway** — off by default; explains and
   escalates; never waves through locked or irreversible actions. Enterprise.

**Safety rules:** never auto-approve a locked rule unless the organisation
opts in per tool; log every automatic decision with its inputs and rule or
model version, marked "no human signature"; show people what they were *not*
asked about, with one tap to turn automatic decisions off; still ask on a
random sample to catch drift; take signals from the gateway, never from text
the agent wrote; reset trust when the agent or tool definition changes.

**Measure fatigue before changing anything:** prompts per person per day,
approval rate (above 95% is a warning), time to decide, approvals made
straight from the notification, expiry rate, repeated identical requests,
and incidents that followed an approval.

**Effort:** decision features and rule evaluation about 4 weeks; conditional
windows and phone UI about 3 weeks; audit feed, off switch and sampling about
2 weeks; metrics 1–2 weeks; suggestions 1–2 weeks; risk scoring 6+ weeks and
needs real data first.

---

## 5. The agent runs its own approved call

**Verdict: decided (September 2026), and it comes early** — items 1 and 3,
and a drop-in gateway, all get simpler once it is in.

**What changes:** today an integrator can hold an approved call and run it
in the background once the phone says yes. Instead, the call runs only when
the agent or automation that asked comes back for it, and the result goes
straight back to it. It is the shape of CIBA's poll mode, a card payment's
"requires action, then confirm", and OAuth step-up.

**How it works:**

1. The first call gets `APPROVAL_REQUIRED` with the 4-digit code, the request
   id and the expiry. Nothing runs.
2. The client comes back when it chooses — the person says "done", it polls
   with the request id, or it never does — and **calls the same tool again
   with the same arguments**. The integrator asks the server to *claim* an
   approved, unused approval for exactly that person, tool and argument hash;
   the server uses it up once, atomically, and the call runs as an ordinary
   call. Nothing needs to be stored in between: not the call, not a token.
3. Still pending: the same code comes back, and no second notification is
   sent. Just denied: the call is refused, so an agent in a loop cannot keep
   ringing the phone. Different arguments: that is a different action, and a
   new approval is raised.
4. An approval nobody comes back for stops being usable after a short window,
   and nothing runs. Later, the phone can say so ("Approved, waiting for your
   agent", then "Not run").

**Why:**

- **Nothing happens behind the caller's back.** An agent that has moved on,
  a finished conversation or a crashed automation cannot have an action run
  without seeing its result.
- **No credentials at rest.** The run uses the credentials on the return
  call, so nothing has to store the agent's token while a person decides.
- **Safe retries.** A single-use approval means a retry after a timeout gets
  "already used", never a second send.
- **Agents can learn from the outcome.** Every approval, denial and expiry
  comes back to the agent that asked — a labelled example of what this person
  accepts. A refund agent learns which refunds get approved and proposes
  better ones. It is the agent-side half of item 4: AgentAction learns when to
  stop asking, the agent learns what to propose. An optional one-tap reason on
  deny ("wrong amount", "not now", "never do this") makes the signal richer.
- **A pluggable gateway becomes almost stateless**, which is what makes
  "put AgentAction in front of your MCP servers, change nothing else" realistic.

**Next:** agent identity (item 3) turns "the same agent" from the same token
into the same verified workload identity: the approval is bound to the agent's
SPIFFE ID, the phone shows the verified agent, and the return call must present
the same identity.

**Server additions:** a claim step that is atomic and single-use, so two
gateway instances cannot both run one approval; the window after which an
unused approval stops working; later, the matching phone states and the
optional deny reason. Because nothing has to be replayed, callers with
short-lived or per-tool credentials work too.

**Effort:** about 1–2 weeks across the server, SDK, app and a reference
gateway, plus the change in each existing integration.

---

## 6. Pluggable for any business, in front of any API or MCP service

**Verdict: the direction, not scheduled yet.** The first platform integration
goes live and proves the product first; businesses are not expected to adopt
AgentAction the day it exists. This item records what "pluggable" means so the
work before it does not close the door.

**The problem today:** AgentAction is a decision service plus a low-level SDK
(evaluate a rule, raise a request, wait, verify a webhook). The first
integration had to write the rest itself — the gate, holding calls, running
each approved call exactly once, a reconciliation sweep, the wait tool —
about 2,500 lines. A business should not have to.

**The principle:** rules and decisions live on the AgentAction server, so every
route below obeys the same rules, and an organisation can govern all of them
from one console. Whatever route is used also registers its tool catalogue,
so the console always knows which tools exist. Item 5 is the foundation: with
the client running its own approved call, nothing stores credentials and the
hold-wait-run logic moves into AgentAction.

**The routes, in the order they should be built:**

1. **An MCP gateway — no code.** A Docker image run in front of the business's
   MCP servers. One config file: the upstream servers, the AgentAction URL and
   key, and how to tell which end user is calling (a header, a claim in a signed
   login token, or a fixed mapping per token). Agents connect to the gateway
   instead; it lists the same tools plus `agentaction_await_approval`, replies
   `APPROVAL_REQUIRED` with the code for a gated call, and forwards the original
   call with the agent's current login once it is approved. Held arguments are
   encrypted and expire on their own, in memory or Redis; arguments are never
   logged. The upstream servers must only be reachable through it.
2. **Hosted pages — no UI to build.** A pairing link the business sends its
   users (the QR code, app-store links and a live "paired" status), and a rules
   page per person with a switch per tool and the business's locked rules
   shown read-only. Served by the approval server, so they are self-hostable.
3. **An HTTP API route — for any automation, not only agents.** The same
   check in front of ordinary REST APIs: middleware for common frameworks
   (Express, Fastify, NestJS) and plugins for common API gateways (Kong,
   Envoy, NGINX), where the "tool" is the method and route. A gated request
   gets a machine-readable "approval required" answer with the code and
   request id; the automation repeats the same request once it is approved.
4. **SDK drop-ins — a few lines.** One core, `ApprovalGate` (`check` →
   run or wait; `resume` → run once, wait, denied, expired or used), with a
   generic on-screen summary per tool that can be overridden. On top of it: a
   one-line middleware for MCP servers built on the official SDK, tool wrappers
   for agent frameworks (OpenAI Agents SDK, Vercel AI SDK, LangChain, Claude
   Agent SDK), and the same core for a business that adds AgentAction to its
   own gateway.
5. **An organisation admin console.** Once an organisation has the gateway or
   the SDK in place, its admins enforce rules centrally: defaults and locks per
   tool, people and their phones, the audit trail, and later enterprise sign-in
   (item 2) and roles. Rules set there apply to every route above.

**What each route needs from the server:** the single-use "use this approval"
step from item 5, tool-catalogue registration, pairing and rules links, and
console sign-in (email link first, enterprise sign-in later).

**Documentation that ships with it:** "Put AgentAction in front of your MCP
server in 10 minutes"; a guide to what an agent receives and how it should tell
the person the code and wait; configuration and API reference; the security
model (who sees what); and running it in production.

**Effort, once scheduled:** gateway and quickstart 2–3 weeks; hosted pages
2–3 weeks; HTTP API middleware and gateway plugins 2–3 weeks; SDK drop-ins 1–2
weeks; admin console 4–6 weeks.

---

## Sequence

With about two engineers, roughly six to eight months in total:

| Phase | What | Time |
|---|---|---|
| 0 | Tighten what exists (above) | 1–2 weeks |
| 0b | The agent runs its own approved call (item 5) | 1–2 weeks |
| 1 | Enterprise sign-in in the app, identity linking, SCIM (item 2) | 6–8 weeks |
| 2 | CIBA provider, then the Keycloak adapter (item 1) | 8–10 weeks |
| 3 | Rule-based adaptive decisioning and fatigue metrics (item 4, parts 1–3) — can run alongside phase 2 | 6–8 weeks |
| 4 | Agent identity: workload tokens, registry, decision v3, receipts, audit export (item 3) | 8–10 weeks |
| 5 | As customers ask: risk scoring, AI classifier hook, Shared Signals, Ping/Curity adapters, hardware-backed keys | — |
| 6 | Pluggable for any business (item 6): MCP gateway, hosted pages, HTTP API route, SDK drop-ins, then the admin console — once the first integration is live | 11–17 weeks |

## Decisions the owner needs to make

1. **Integration shape:** AgentAction as its own CIBA provider (recommended),
   with identity-provider adapters only where the action's details survive —
   Keycloak first?
2. **Licensing:** keep everything Apache-2.0 and sell hosting and support, or
   put the enterprise modules (SAML/SCIM/Shared Signals, risk scoring, FAPI)
   under a commercial licence? Decide before building them — code published
   under Apache stays Apache.
3. **Privacy boundary for adaptive decisions:** do integrators send typed
   decision features to the server (in the clear, or as keyed hashes), or does
   that logic live in the SDK and gateway? And may a window or an automatic
   decision ever override a locked rule?
4. **Agent identity posture:** a verifier with a registry (recommended), or a
   certificate authority competing with AgentPass? Which identity sources to
   accept, and are unregistered agents refused or only flagged?
5. **Assurance level:** move approval signing into the Secure Enclave /
   StrongBox? That means switching from Ed25519 to P-256 and a new decision
   message version, and it is a prerequisite for bank-grade (FAPI) claims.
6. **Pluggable editions:** which of the gateway, hosted pages and admin console
   are open source and self-hostable, and which are hosted or Enterprise-only?
   And where does the admin console live for customers who do not self-host?

## Sources

OpenID CIBA Core 1.0 and the FAPI-CIBA profile (openid.net); RFC 9396 (rich
authorization requests); RFC 8693 (token exchange); RFC 8252 and RFC 7643/7644
(native-app OAuth, SCIM); IETF WIMSE working-group drafts, including AIMS;
the OAuth SPIFFE client-authentication draft; vendor documentation for
Keycloak, PingFederate, PingAM, Curity, Auth0, Okta and Microsoft Entra;
agentpass.co.uk; OWASP Top 10 for Agentic Applications; the OpenID
Foundation's paper on identity management for agentic AI; EU AI Act
Article 14 and Regulation (EU) 2026/1744; DORA. Items marked "needs checking"
above were not confirmed.
