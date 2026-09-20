# Device smoke list

Run this on a real phone before enabling approval for any customer. Automated
tests cover the server; these are the things only a device can prove.

Setup: the approval server reachable from the phone, a tenant and a subject
created, and the app installed — see [../TESTING.md](../TESTING.md).

## Pairing

| # | Step | Expected |
|---|---|---|
| 1 | Portal → Approvals → Add a phone | A QR code and a typed code appear |
| 2 | Scan it in the app | Confirm sheet names the agency and the customer account |
| 3 | Confirm with Face ID / fingerprint | Device appears in the portal or your own admin UI within a second or two, with the right brand in the app |
| 4 | Scan the same QR again | Refused: the code is single use |
| 5 | Leave a new code for six minutes, then scan | Refused: expired |
| 6 | Pair a second phone | Both listed; the first phone gets a "new phone added" alert |

## Approving

| # | Step | Expected |
|---|---|---|
| 7 | Turn on approval for one low-risk tool; call it from an MCP client | The agent gets APPROVAL_REQUIRED with a 4-digit code; nothing runs |
| 8 | Check the notification on the lock screen | Brand, tool and code only — no arguments |
| 9 | Open it | The code matches the agent's message; arguments are readable plain text |
| 10 | Approve | Biometric prompt; the action runs once; the agent's `internal_await_approval` returns the result |
| 11 | Repeat and Deny | Nothing runs; the agent is told it was denied |
| 12 | Repeat and wait out the expiry | Nothing runs; the request shows as expired on both sides |
| 13 | With two phones paired, approve on one | The other clears its notification and shows who decided |
| 14 | Approve with "for 15 minutes", then repeat the same call | The second call runs without asking |

## Recovery and failure

| # | Step | Expected |
|---|---|---|
| 15 | Revoke a device in the portal or your own admin UI, then try to approve on it | Refused; the app drops the account |
| 16 | Pair a fresh phone while a request is waiting | The waiting request appears on it |
| 17 | Stop the approval server, then call a gated tool | The call is refused, not allowed through |
| 18 | Start it again, approve a parked call | It runs; the reconciliation catches anything the webhook missed |
| 19 | Aeroplane mode on the phone, approve after coming back online | Works, or says the request expired — never a silent failure |
| 20 | Kill the agent (close the coding session) after parking a call, then approve | The action still runs |

## Realtime and voice agents

| # | Step | Expected |
|---|---|---|
| 21 | Gate a tool your voice or realtime agent uses, then trigger it | The agent tells the caller it needs approval and moves on; the call does not hang |
| 22 | Approve after hanging up | The action runs |

## Rules and locks

| # | Step | Expected |
|---|---|---|
| 23 | Agency sets a locked rule | The customer sees it on and cannot switch it off |
| 24 | Customer turns a rule on with no phone paired | The portal warns them first; a call is then refused with "no phone is connected" |
| 25 | Turn every rule off | Calls run exactly as before, with no approval step |

Record the date, the build, and anything that failed.
