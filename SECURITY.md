# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Email **[connect@agentaction.online](mailto:connect@agentaction.online)** with
`SECURITY` in the subject line, or use GitHub's
[private vulnerability reporting](https://github.com/avijeett007/agentaction/security/advisories/new).

Useful to include:

- What an attacker can do, and what they need in order to do it — a pairing, an
  API key, network position, a malicious agent, nothing at all.
- Which piece: server, SDK, phone app, or the site.
- The version or commit.
- A minimal reproduction.

**Redact real values.** Do not send working API keys, pairing secrets, device
keys or customer data — the shape of the request is enough, and anything you
send lives on in a mailbox.

You will get an acknowledgement. The team is small, so a fix may not be
immediate, but reports that let someone bypass an approval or act on another
tenant's data are treated as urgent and jump the queue.

## What is in scope

The code in this repository: the server, the SDK, and the phone app.

Most interesting to us, roughly in order:

- **Approving something the approver did not approve.** Forged, replayed or
  swapped decisions; a decision applying to a different call, different
  arguments, or a longer window than was signed.
- **Acting without an approval at all** — bypassing the gate rather than faking
  its answer.
- **Crossing a tenant boundary**: reading or acting on another tenant's
  requests, pairings or keys.
- **Extracting a device key**, or getting a decision signed without the
  biometric prompt the device is configured to require.
- **Pairing takeover**: claiming a code that was not meant for you, or reusing
  one.

## What is not

- The hosted service at `agentaction.online` and its portal — those are operated
  separately. Reports about them are still welcome at the same address; they are
  just not about this code.
- Findings that need an attacker who already controls the server or the unlocked
  phone.
- Missing hardening with no demonstrated impact, and scanner output without a
  reproduction.
- Denial of service through sheer volume.

## Safe harbour

Test against **your own** installation and your own devices. Do not test against
the hosted service, other people's tenants, or the phone of anyone who has not
agreed to it. Research done that way, reported privately and given reasonable
time before disclosure, is welcome — we will not pursue it.
