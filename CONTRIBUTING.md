# Contributing to AgentAction

Thanks for looking. Please read this first — how this repository works is
unusual, and it changes what is worth your time.

## This repository is a published snapshot

AgentAction is developed in a private repository and **published here as a
snapshot**: each release replaces the tree wholesale with one commit. Nothing
here is a working branch.

The practical consequence, and the reason it is the first thing on this page:

> **A pull request merged here would be silently reverted by the next publish.**

That is not a policy decision anyone could waive — it is how the mirror works.
A change only survives if it is made in the private repository, so a PR cannot
reach the code by this route even when the change is a good one.

## So contributions are not being accepted

Beyond the mirror, the team here is small and busy building the product. There
is no capacity to review, test and carry incoming pull requests to the standard
they would deserve, so **unsolicited PRs will generally be closed without a full
review**. Nothing personal — it is the only honest answer, and leaving PRs open
for months would waste more of your time than closing them.

**What genuinely helps instead:**

- 🐛 **Found a bug?** [Open an issue](https://github.com/avijeett007/agentaction/issues).
  Bug reports are read and acted on — they are far more useful here than a patch.
- 💡 **Want a feature?** [Open an issue](https://github.com/avijeett007/agentaction/issues)
  describing the *problem*, not the implementation. Features land over time; no
  timelines promised.
- 🍴 **Want to change it for yourself?** AgentAction is **Apache-2.0**. Fork it,
  run it, ship it inside your own product. That is encouraged and needs no
  permission — see [Licence](README.md#licence).
- 🔒 **Found a vulnerability?** Do **not** open an issue. [SECURITY.md](SECURITY.md).
- ✉️ **Anything else?** **[connect@agentaction.online](mailto:connect@agentaction.online)**.

If a change matters enough that you want it upstream rather than in your fork,
open an issue describing it and say you have a working patch in a fork. That is
the one route that can lead to it being reimplemented here.

## Reporting a bug

Before filing:

1. **[Search existing issues](https://github.com/avijeett007/agentaction/issues?q=is%3Aissue)**,
   including closed ones.
2. **Try the [latest release](https://github.com/avijeett007/agentaction/releases/latest)**
   in case it is already fixed.

Then include:

- **The error code.** Every failure returns `{"error":{"code":…,"message":…}}`
  and the code is the useful part — more so than the message.
- **Which piece**: server, SDK, phone app, or the site.
- **Versions**: the release or commit, and Node's version for the server.
- **For anything involving a phone**: the platform, the OS version, and whether
  the build came from a store or was a `preview`/`release-apk` build. These
  behave differently, and "the app" on its own is rarely enough to reproduce.
- What you did, what you expected, what happened.

**Never paste real tool arguments, tokens, pairing codes or customer data into
an issue.** Approval requests carry exactly the payloads that are worth
protecting. Redact them, or describe their shape instead.

## Running it yourself

The fastest path to a working server, from the [README](README.md#quick-start):

```bash
npm install                       # server/ and sdk/ are npm workspaces
cd server && npx prisma generate
cd .. && npm test                 # server + SDK tests
```

The phone app is deliberately outside the workspace — it has its own
dependencies and its own test suite:

```bash
cd app && npm install && npm test
```

Running the server against a local SQLite file, and the end-to-end walkthrough
against a real phone, are both in [TESTING.md](TESTING.md).

## If you send a PR anyway

It will most likely be closed — see above — but if you have been asked for one,
or you are opening it as a reference for an issue:

- **TypeScript**: strict types, no `any` in production paths. Errors are handled
  explicitly, never swallowed.
- **Tests**: every behaviour change comes with a test. A bug fix comes with a
  regression test that fails before the fix.
- **Commits**: conventional prefixes — `feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`.
- **Run `npm test` before pushing.**
- **AI-assisted work is fine** — most of this repository was written with it.
  Just say so in the PR description, and which tools, so it can be read with
  that in mind.

## Licence

By contributing you agree that your contributions are licensed under
**[Apache-2.0](LICENSE)**, the same as the rest of the repository. See
[NOTICE](NOTICE) for what that does and does not cover.
