# AgentAction roadmap

Written for the people deciding what AgentAction builds next: the owner, early
partners and anyone evaluating it for an organisation. Each item says what it
means, whether it is feasible, how we would build it and roughly what it costs.
Effort is in engineer-weeks. Nothing below is built yet unless it says so.

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

## Sequence

With about two engineers, roughly six to eight months in total:

| Phase | What | Time |
|---|---|---|
| 0 | Tighten what exists (above) | 1–2 weeks |
| 1 | Enterprise sign-in in the app, identity linking, SCIM (item 2) | 6–8 weeks |
| 2 | CIBA provider, then the Keycloak adapter (item 1) | 8–10 weeks |
| 3 | Rule-based adaptive decisioning and fatigue metrics (item 4, parts 1–3) — can run alongside phase 2 | 6–8 weeks |
| 4 | Agent identity: workload tokens, registry, decision v3, receipts, audit export (item 3) | 8–10 weeks |
| 5 | As customers ask: risk scoring, AI classifier hook, Shared Signals, Ping/Curity adapters, hardware-backed keys | — |

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
