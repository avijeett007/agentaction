/**
 * agentaction.online — static site plus one endpoint.
 *
 * The site is served from `dist` by Cloudflare's asset handler. The only thing
 * this Worker adds is `POST /api/signup`, which exists because of a real bug:
 *
 *   "Try AgentAction" used to link to portal.agentaction.online/register, the
 *   generic registration. That path does not go through the experience
 *   conversion, so the customer arrived with NO connected apps and NO free
 *   credits — none of what the partner configured on the experience. They
 *   landed in an empty portal and had no idea why.
 *
 * The portal's own experience landing signs people up correctly, so this does
 * exactly what that does: posts the email to the shared experience-lead
 * endpoint, whose free-experience path converts the lead into a customer and
 * provisions them.
 *
 * WHY A WORKER RATHER THAN POSTING FROM THE BROWSER
 *  - The browser is on agentaction.online and the endpoint is on
 *    portal.agentaction.online. Proxying here avoids CORS entirely.
 *  - The `Host` on the outbound request is what resolves the partner: the
 *    portal's middleware strips any inbound `x-partner-id` and re-stamps it
 *    from the resolved host, so calling the portal's own domain lands on the
 *    right tenant and cannot be spoofed from outside.
 *  - It gives somewhere to rate-limit a form that anyone on the internet can see.
 *
 * WHAT THIS DELIBERATELY DOES NOT HAVE: a partner API key. The sibling
 * viddescriptor worker holds one because it calls the authenticated partner
 * API. The experience-lead endpoint is public and anonymous, so there is no
 * secret here to leak, rotate or forget. Fewer secrets is the better design.
 */

/**
 * Where a signup is forwarded. Deployment configuration, not source, for two
 * reasons: it differs per deployment, and the endpoint it names creates
 * accounts without authentication. A visitor only ever sees `/api/signup` on
 * this origin — the proxy is what keeps the real one out of reach — so writing
 * it into published source would hand anyone a way to call it directly.
 *
 * Set `SIGNUP_ENDPOINT` and `SIGNUP_EXPERIENCE_TYPE` as vars in wrangler.jsonc.
 */

/** Deliberately loose: the only authority on an address is sending mail to it. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;

export interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  /** Full URL of the signup endpoint to forward to. */
  SIGNUP_ENDPOINT?: string;
  /** The experience type sent alongside the email. */
  SIGNUP_EXPERIENCE_TYPE?: string;
}

/**
 * Per-IP throttle held in module memory.
 *
 * Honest about what it is: an isolate lives for minutes and Cloudflare runs
 * many, so this is a speed bump, not a guarantee. It costs nothing and stops
 * the trivial case — someone holding down a button, or a naive script. Real
 * abuse protection belongs upstream where the account is actually created, and
 * the endpoint already dedupes by (partner, email) so a replay cannot mint a
 * second customer.
 */
const hits = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // bounded; this is a speed bump, not a ledger
  return recent.length > RATE_LIMIT_MAX;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function handleSignup(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let email = '';
  try {
    const body = (await request.json()) as { email?: unknown };
    email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  } catch {
    return json({ error: 'That did not look like a valid request.' }, 400);
  }

  if (!EMAIL.test(email)) {
    return json({ error: 'That does not look like an email address.' }, 400);
  }

  // Throttled here, AFTER validation, deliberately. Counting rejected input
  // would mean five typos lock someone out of a signup form for ten minutes,
  // and a malformed request never reached the network anyway. What is worth
  // limiting is the thing that costs something: the upstream call that can
  // create an account and send mail.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (rateLimited(ip)) {
    return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  }

  const endpoint = env.SIGNUP_ENDPOINT;
  if (!endpoint) {
    // Misconfigured rather than broken. Say so plainly instead of reporting a
    // network failure the visitor could do something about.
    return json({ error: 'Signup is not configured on this deployment.' }, 503);
  }

  let upstream: Response;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, experienceType: env.SIGNUP_EXPERIENCE_TYPE }),
    });
  } catch {
    return json({ error: 'We could not reach the signup service. Please try again shortly.' }, 502);
  }

  // Not every failure is JSON: a proxy 502 answers with HTML, and an unguarded
  // .json() surfaces a parser message to the visitor as if it were our copy.
  const data = (await upstream.json().catch(() => null)) as
    | { success?: boolean; error?: unknown }
    | null;

  if (!upstream.ok || !data?.success) {
    const message =
      typeof data?.error === 'string' && data.error
        ? data.error
        : 'That did not go through. Please try again in a moment.';
    // Upstream's status is passed through so a 409 "already registered" does
    // not read to the visitor as a server fault.
    return json({ error: message }, upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
  }

  return json({ success: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/signup') return handleSignup(request, env);
    return env.ASSETS.fetch(request);
  },
};
