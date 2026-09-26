/**
 * Build the AgentAction marketing site.
 *
 * There is no framework and there are no dependencies. `src/` is already a
 * working site — open `src/index.html` and it runs. This script copies it to
 * `dist/`, strips comments, collapses whitespace in the CSS and JS, and then
 * checks the output for the things that must never appear on a public page.
 *
 *   node build.mjs          build into dist/
 *   node build.mjs --check  build, then fail loudly on a leak or a dead link
 */

import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'src');
const DIST = join(HERE, 'dist');

/* Things that must never reach a public page. The site is written from a
 * private repository, so this runs on every build rather than on trust.
 * These are the generic rules; the deployment's own hostnames and internal
 * names come from the private deny-list, added below when it is present. */
const FORBIDDEN = [
  // The company name is public — Kno2gether Labs owns this product and is
  // named in the footer. Anything else in that name is not.
  { re: /kno2gether(?!\s+Labs)/i, why: 'internal org reference (use "Kno2gether Labs")' },
  { re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/, why: 'private IP address' },
  { re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/, why: 'private IP address' },
  { re: /aa_live_/, why: 'live API key prefix' },
  { re: /ExponentPushToken/, why: 'push token' },
  { re: /\bsmoke-[a-z0-9-]+/i, why: 'test identifier' },
  { re: /ADMIN_API_KEY\s*=\s*["'][^"'$]/, why: 'a literal admin key value' },
];

/* The private deny-list (../.publish/denylist) never leaves the private
 * repository; see scripts/publish-public.sh. One regex per line. */
try {
  const privateList = await readFile(new URL('../.publish/denylist', import.meta.url), 'utf8');
  for (const line of privateList.split('\n')) {
    const pattern = line.trim();
    if (pattern && !pattern.startsWith('#')) {
      FORBIDDEN.push({ re: new RegExp(pattern, 'i'), why: 'private deny-list' });
    }
  }
} catch {
  // Not present in a public checkout: the generic rules above still apply.
}

/* Where "read the source" points. Public since 2026-09-20. */
const REPO_URL = 'https://github.com/avijeett007/agentaction';

const args = new Set(process.argv.slice(2));
const CHECK = args.has('--check');

const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

async function walk(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s*([{}:;,>])\s*/g, '$1')
    .replace(/;}/g, '}')
    .replace(/\s+/g, ' ')
    .trim();
}

function minifyJs(js) {
  // Deliberately conservative: only whole-line comments and leading indent.
  // Anything cleverer needs a parser, and this file is 6 KB.
  return js
    .split('\n')
    .map((l) => l.replace(/^\s+/, ''))
    .filter((l) => l && !/^\/\//.test(l) && !/^\/?\*/.test(l))
    .join('\n');
}

function minifyHtml(html) {
  // <pre> carries significant whitespace: lift it out, minify around it, and
  // put it back byte for byte.
  const pres = [];
  const parked = html.replace(/<pre[\s\S]*?<\/pre>/g, (m) => {
    pres.push(m);
    return `\u0000PRE${pres.length - 1}\u0000`;
  });

  const squeezed = parked
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{2,}/g, '\n');

  return squeezed.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)]);
}

/* The FAQ's structured data is built from the questions on the page, word for
 * word, because search engines require the two to match. */
function withFaqSchema(html) {
  const strip = (t) => t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const items = [...html.matchAll(/<details><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g)]
    .map((m) => ({ '@type': 'Question', name: strip(m[1]), acceptedAnswer: { '@type': 'Answer', text: strip(m[2]) } }));
  const schema = { '@context': 'https://schema.org', '@type': 'FAQPage', '@id': 'https://agentaction.online/#faq', mainEntity: items };
  return html.replace(/(<script type="application\/ld\+json" id="faq-schema">)[\s\S]*?(<\/script>)/,
    (_, open, close) => open + JSON.stringify(schema).replace(/</g, '\\u003c') + close);
}

async function build() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST, { recursive: true });

  const files = await walk(SRC);
  let bytes = 0;

  for (const file of files) {
    const rel = relative(SRC, file);
    const dest = join(DIST, rel);
    await mkdir(dirname(dest), { recursive: true });

    const ext = extname(file);
    // Vendored libraries are copied byte for byte. They are already minified,
    // and the line-based pass below would strip their licence headers.
    if (rel.split(/[/\\]/).includes('vendor')) {
      await copyFile(file, dest);
    } else if (ext === '.html') {
      await writeFile(dest, minifyHtml(withFaqSchema(await readFile(file, 'utf8'))));
    } else if (ext === '.css') {
      await writeFile(dest, minifyCss(await readFile(file, 'utf8')));
    } else if (ext === '.js') {
      await writeFile(dest, minifyJs(await readFile(file, 'utf8')));
    } else {
      await copyFile(file, dest);
    }
    bytes += (await stat(dest)).size;
  }

  log(`built ${files.length} files into dist/ (${(bytes / 1024).toFixed(1)} KB total)`);
  return walk(DIST);
}

async function audit(distFiles) {
  const problems = [];
  const textExt = new Set(['.html', '.css', '.js', '.svg', '.txt', '.json', '']);

  for (const file of distFiles) {
    if (!textExt.has(extname(file))) continue;
    const body = await readFile(file, 'utf8');
    for (const rule of FORBIDDEN) {
      const hit = body.match(rule.re);
      if (hit) problems.push(`${relative(DIST, file)}: ${rule.why} — "${hit[0]}"`);
    }
  }

  // Every local href/src must resolve to a file that was actually built.
  const html = await readFile(join(DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:href|src)="(\/[^"#]+)"/g)].map((m) => m[1]);
  const built = new Set(distFiles.map((f) => '/' + relative(DIST, f).split('\\').join('/')));
  for (const ref of new Set(refs)) {
    // Cloudflare's static assets serve /privacy from privacy.html, so an
    // extensionless link is correct rather than dead. Model that here, or the
    // audit rejects exactly the clean URLs we want to publish.
    const resolves = built.has(ref) || built.has(`${ref}.html`) || built.has(`${ref}/index.html`);
    if (!resolves) problems.push(`index.html: local link has no file — ${ref}`);
  }

  // Every in-page anchor must have a target.
  const anchors = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  for (const id of new Set(anchors)) {
    if (!new RegExp(`id="${id}"`).test(html)) problems.push(`index.html: #${id} has no target`);
  }

  // The hero upgrade is loaded by a dynamic import, so it never appears in an
  // href or src. Check it, and whatever it imports, the same way.
  const js = await readFile(join(DIST, 'main.js'), 'utf8');
  for (const m of js.matchAll(/import\('(\/[^']+)'\)/g)) {
    if (!built.has(m[1])) problems.push(`main.js: dynamic import has no file — ${m[1]}`);
    else {
      const mod = await readFile(join(DIST, m[1].slice(1)), 'utf8');
      for (const n of mod.matchAll(/from\s+'(\/[^']+)'/g)) {
        if (!built.has(n[1])) problems.push(`${m[1]}: import has no file — ${n[1]}`);
      }
    }
  }

  // The CSP has to permit what the page actually does.
  //
  // This check exists because of a real escape. `connect-src 'none'` was
  // correct for years — the site made no network calls at all. Adding the
  // signup fetch made it wrong, and nothing caught it: curl and the worker
  // tests never see a CSP, because only a browser enforces one. The endpoint
  // answered perfectly while every visitor got "No connection".
  //
  // So: derive what the page needs from the page, and compare.
  const headers = await readFile(join(DIST, '_headers'), 'utf8');
  const csp = (headers.match(/Content-Security-Policy:([^\n]*)/) ?? [, ''])[1];
  const directive = (name) => {
    const m = csp.match(new RegExp(`(?:^|;)\\s*${name}\\s+([^;]+)`));
    return m ? m[1].trim() : null;
  };
  const pageScripts = [js, ...(await Promise.all(
    distFiles.filter((f) => f.endsWith('.js') && !f.endsWith('main.js')).map((f) => readFile(f, 'utf8')),
  ))].join('\n');

  if (/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket|new EventSource/.test(pageScripts)) {
    const connect = directive('connect-src');
    if (!connect || connect === "'none'") {
      problems.push(
        "_headers: the page makes network calls but connect-src is " +
        `${connect ?? 'unset (falls back to default-src)'} — every request will be blocked in a browser`,
      );
    }
  }

  // A <form> that is not submitted by JavaScript needs somewhere to post.
  // Ours is intercepted, so form-action stays locked; flag it only if an
  // action attribute appears, which means a real submit is intended.
  if (/<form[^>]+action=/.test(html) && directive('form-action') === "'none'") {
    problems.push("_headers: a form has an action but form-action is 'none' — the submit will be blocked");
  }

  // The vendored library keeps its licence, or it does not ship.
  const vendor = distFiles.filter((f) => f.includes('vendor'));
  for (const v of vendor) {
    const body = await readFile(v, 'utf8');
    if (!/SPDX-License-Identifier|@license/.test(body)) {
      problems.push(`${relative(DIST, v)}: vendored file lost its licence header`);
    }
  }

  if (problems.length) {
    console.error('\nBUILD AUDIT FAILED\n' + problems.map((p) => '  ✗ ' + p).join('\n') + '\n');
    return false;
  }
  log('audit passed: no secrets, no internal hostnames, no dead local links, CSP covers what the page does');

  const kb = async (p) => (await stat(join(DIST, p))).size / 1024;
  const first = ['index.html', 'styles.css', 'main.js', 'assets/fonts/archivo-latin.woff2', 'assets/favicon.svg'];
  let sum = 0;
  for (const f of first) sum += await kb(f);
  log(`first load: ${sum.toFixed(1)} KB (images and the video load when they come into view)`);
  return true;
}

const distFiles = await build();
const ok = await audit(distFiles);
if (CHECK && !ok) process.exit(1);
