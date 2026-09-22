# agentaction.online — the public site

One page, no framework, no runtime dependencies. `src/` is already a working
site: open `src/index.html` in a browser and it runs. The build copies `src/`
to `dist/`, minifies it, adds the FAQ structured data, and then audits the
output for things that must never appear on a public page.

```bash
npm run build      # src/ → dist/, with the audit. This is what gets deployed.
npm run dev        # serve src/ on http://localhost:4321 while you edit
npm run preview    # serve the built site through Wrangler, as Cloudflare will
npm run deploy     # publish dist/ (see "Deploying" below)
```

The build is Node's standard library and nothing else. Wrangler is the only
dev dependency, and only the preview and deploy commands use it.

## What the build does

- **Minifies** the HTML, CSS and JavaScript.
- **Writes the FAQ structured data from the page itself.** The `FAQPage`
  JSON-LD is generated from the visible `<details>` questions at build time,
  so the answers search engines read are always the answers people read.
- **Audits `dist/`** and exits non-zero if it finds live API key prefixes, push
  tokens, private IP ranges, internal hostnames or identifiers, a local
  `href`/`src` with no matching file, or an in-page anchor with no target. The
  list of private terms is kept outside this repository; the check that uses
  it runs wherever that list is present.
- **Reports the first-load weight** — about 100 KB today. Images and the video
  load only when they scroll into view.

## Layout

```
site/
├── build.mjs            src/ → dist/, minify, FAQ schema, audit
├── serve.mjs            local static server (development only)
├── og/                  the HTML the Open Graph image is rendered from
└── src/
    ├── index.html       the whole page
    ├── styles.css       one stylesheet, CSS custom properties
    ├── main.js          progressive enhancement only — the page works without it
    ├── _headers         security headers and caching
    ├── robots.txt
    ├── sitemap.xml
    └── assets/
        ├── favicon.svg, apple-touch-icon.png, og.png
        ├── fonts/       Archivo, one self-hosted variable woff2
        ├── media/       the 30-second explainer video and its poster
        └── logos/       marks of the apps AgentAction is going into first
```

Nothing is loaded from a third party at runtime: no analytics, no cookies, no
`connect-src`. `src/_headers` sets a strict Content-Security-Policy
(`default-src 'none'`, everything same-origin, no inline script or style), HSTS,
`nosniff`, `Referrer-Policy: no-referrer`, and a `Permissions-Policy` denying
camera, microphone, geolocation and payment. If the policy ever needs
loosening, something has been added that does not belong on this site.

## The hero demo

The phone in the hero shows the AgentAction app's request screen, recreated in
HTML with the app's own colours and wording (`../app/lib/theme.ts`,
`../app/screens/RequestScreen.tsx`). It is authored in its finished state, so
the page reads with JavaScript blocked. `main.js` plays the arrival once when it
comes into view, and lets a visitor answer it — Approve, Deny, or approve for a
while — with the chat beside it showing what the agent is told. Under
`prefers-reduced-motion` nothing moves.

## Assets and licences

- **Archivo** is SIL Open Font License 1.1, self-hosted rather than fetched from
  a font CDN, latin subset only.
- **`assets/logos/`** holds the marks published by the sites named in the
  "Coming to these apps first" section, copied locally rather than hot-linked,
  and used only to identify them there.
- The **explainer video** was built from the app's own screens and wording.
- The AgentAction mark comes from `../brand/`. One brand rule shapes the page:
  on the page, green means approved, red means denied and amber means waiting,
  and none of them is used as decoration.

## What the page claims

Everything stated is meant to be checkable against this repository:

- API calls, endpoints, field names and the webhook signature format come from
  `../server/`, `../sdk/src/` and `../README.md`, and the developer code sample
  compiles against the SDK.
- Every host is `example.com`, every key an environment variable; there are no
  real ids anywhere.
- Limitations are stated on the page, not buried: enterprise features that are
  not built yet say so, and the security section describes what the approval
  server can and cannot see.

## Deploying

The site is served as a Cloudflare Worker with static assets. The deployment's
own Wrangler configuration is not part of this repository; a minimal one looks
like this:

```jsonc
// wrangler.jsonc
{
  "name": "agentaction-site",
  "compatibility_date": "2026-09-18",
  "assets": { "directory": "dist" },
  "routes": [{ "pattern": "example.com", "custom_domain": true }]
}
```

```bash
npm run build
npx wrangler deploy
```

Wrangler reads `CLOUDFLARE_API_TOKEN` when it is set. If that token lacks the
Workers permissions, the deploy fails with an authentication error that looks
like a bad token; either use a token with **Workers Scripts: Edit** (and
**Workers Routes: Edit** for a custom domain), or unset it and let
`wrangler login` use your account.
