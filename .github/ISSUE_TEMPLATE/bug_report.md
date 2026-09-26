---
name: 🐛 Bug report
about: Something behaves differently from how it is documented
title: ''
labels: bug
assignees: ''
---

<!--
  ⚠️ Not for security issues. If this lets someone approve something they should
  not, act without an approval, or reach another tenant's data, close this and
  read SECURITY.md instead.

  ⚠️ Never paste real tool arguments, tokens, pairing codes or customer data.
  Approval requests carry exactly the payloads worth protecting — redact them or
  describe their shape.
-->

## The error code

<!--
  Every failure returns {"error":{"code":…,"message":…}}. The code is the useful
  part — more so than the message. Paste the whole body if you have it.
-->

## Which piece

- [ ] Server
- [ ] SDK
- [ ] Phone app
- [ ] The site / docs

## What happened

<!-- What you did, what you expected, what actually happened. -->

## Steps to reproduce

1.
2.
3.

## Versions

- Release or commit:
- Node (for the server):
- Database: SQLite / PostgreSQL

## If a phone is involved

<!--
  These behave differently and "the app" alone is rarely enough to reproduce.
-->

- Platform and OS version:
- Where the build came from: Play Store / TestFlight / `preview` / `release-apk`
- Was it paired at the time, and had it been re-paired recently?

## Anything else

<!-- Logs and screenshots help. Redact them first. -->
