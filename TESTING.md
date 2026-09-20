# Testing AgentAction on a real phone

The unit and integration tests cover the protocol byte-for-byte. What they
cannot cover is a camera, a fingerprint, a push notification and a phone that
goes to sleep — so this is the part a person has to do.

You need: the app on a phone, and a server the phone can reach. Nothing has to
be deployed — a laptop on the same Wi-Fi is enough.

## 1. The app

**Android** — build an APK and install it directly:

```bash
cd agentaction/app
npx eas-cli build --platform android --profile preview
```

EAS prints a URL; open it on the phone and install. Android will ask you to
allow installing from that source.

**iOS** — needs one interactive run, because Apple requires a signed
provisioning profile naming the exact device and EAS has to log in to do it:

```bash
cd agentaction/app
npx eas-cli device:create     # opens a page, register the phone
npx eas-cli build --platform ios --profile preview
```

## 2. The server

Run it on a laptop on the same Wi-Fi as the phone. The pairing code carries the
server's URL, and the app accepts a `192.168.x` address over plain HTTP for
exactly this reason.

```bash
cd agentaction/server
npm install
npx prisma generate
DATABASE_URL="file:./smoke.db" npx prisma db push

# use your own address here — `ipconfig getifaddr en0` on a Mac
DATABASE_URL="file:./smoke.db" \
PORT=4890 \
PUBLIC_BASE_URL="http://192.168.1.10:4890" \
ADMIN_API_KEY="pick-something" \
npx tsx src/index.ts
```

Check it from the phone's browser first: `http://192.168.1.10:4890/health`
should say `{"status":"ok"}`. If it does not, the laptop's firewall is in the
way and nothing below will work.

## 3. A tenant and a pairing code

```bash
# once
curl -s -X POST http://192.168.1.10:4890/v1/tenants \
  -H "authorization: Bearer pick-something" -H "content-type: application/json" \
  -d '{"name":"Example Agency","brandName":"Example","brandColor":"#5B8CFF"}'
# keep the apiKey it prints — it is shown once

# each time you pair (codes last five minutes)
curl -s -X POST http://192.168.1.10:4890/v1/pairings \
  -H "authorization: Bearer aa_live_..." -H "content-type: application/json" \
  -d '{"externalId":"customer-1","label":"Test account"}' \
  | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['qrPayload']))"
```

That last command prints the pairing payload. Either render it as a QR code and
scan it, or send it to the phone and use **Pair a phone → Enter the code
instead**.

## 4. Raise something to approve

```bash
curl -s -X POST http://192.168.1.10:4890/v1/requests \
  -H "authorization: Bearer aa_live_..." -H "content-type: application/json" \
  -d '{"externalId":"customer-1","actorLabel":"Claude Code",
       "resourceKey":"gmail/GMAIL_SEND_EMAIL","title":"Send email via Gmail",
       "fields":[{"label":"To","value":"patient@example.com"},
                 {"label":"Subject","value":"Your appointment"}],
       "argsHash":"'"$(printf 'a%.0s' {1..64})"'"}'
```

It should appear in the app. Approve it, then confirm the gateway's view agrees:

```bash
curl -s http://192.168.1.10:4890/v1/requests/<id> -H "authorization: Bearer aa_live_..."
```

## Push notifications

Push is on by default, and the server sends without any extra configuration —
an Expo access token is optional, and buys enhanced security rather than the
ability to send:

```bash
EXPO_ACCESS_TOKEN=...   # expo.dev → Account settings → Access tokens
EXPO_PUSH_DISABLED=true # sends nothing at all; what the test suite uses
```

Push still needs a real build: Expo Go cannot get a push token. Without one
nothing else is lost, because the app loads what is waiting whenever it opens
or is pulled down to refresh.

## What to actually check

The full list is [docs/device-smoke.md](docs/device-smoke.md) — 25 checks
covering pairing, expiry, approve, deny, revoke, two phones racing,
losing a phone, and the server being down. The five that matter most:

1. The confirm sheet names the right brand and account **before** anything is
   registered.
2. Approving demands the fingerprint or Face ID, and **cancelling it does not
   approve**.
3. The notification on the lock screen shows the tool and the code but **no
   argument values**.
4. Revoking the device in the portal stops it deciding anything, immediately.
5. Killing the server means gated calls are **refused**, never quietly allowed.

## A protocol check without a phone

`server/scripts/protocol-check.mjs` does the whole exchange over HTTP with
generated keys: register, park, list, open, sign, approve, and a deliberately
mismatched signature that must be refused. Useful for proving the server is
healthy before blaming the device.

```bash
cd agentaction/server
BASE=http://192.168.1.10:4890 API_KEY=aa_live_… SECRET=<a fresh pairing secret> \
  node scripts/protocol-check.mjs
```

It pairs itself as a device on `customer-1`, so mint the pairing code for
that account, not the one your phone is using.
