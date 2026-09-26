/**
 * The signup endpoint on agentaction.online.
 *
 * This exists because linking "Try AgentAction" straight to /register was a bug:
 * that path does not go through the experience conversion, so the customer
 * arrived with no connected apps and no free credits and had no idea why. The
 * endpoint posts to the same place the portal's own experience landing does.
 *
 * Run with: node --test test/signup.test.mjs
 * No framework: the worker is a plain module with one dependency (global fetch),
 * which a stub replaces. Adding vitest to a static site for one file would cost
 * more than it returns.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

const worker = (await import('../worker/index.ts').catch(() => null))
  ?? (await import('../worker/index.js').catch(() => null));

// The worker is TypeScript; when it cannot be imported directly (no loader),
// skip loudly rather than passing silently on nothing.
const available = !!worker?.default?.fetch;

const ASSETS = { fetch: async () => new Response('the site', { status: 200 }) };

// The real endpoint is deployment config (see worker/index.ts), so the tests
// supply their own rather than asserting a production URL.
const ENDPOINT = 'https://portal.example/api/leads/demo';
const ENV = { ASSETS, SIGNUP_ENDPOINT: ENDPOINT, SIGNUP_EXPERIENCE_TYPE: 'DEMO_TYPE' };

// The limiter's state is module-level and survives between tests, so every test
// gets its own IP. Sharing one would make each test depend on how many requests
// the tests before it happened to make.
let ipCounter = 0;
const freshIp = () => `203.0.113.${(ipCounter += 1) % 250}`;

const post = (body, headers = {}, ip = freshIp(), env = ENV) =>
  worker.default.fetch(
    new Request('https://agentaction.online/api/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env,
  );

let realFetch;
let calls;

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('POST /api/signup', { skip: available ? false : 'worker/index.ts needs a TS loader' }, () => {
  test('posts a normalised address to the experience-lead endpoint', async () => {
    const res = await post({ email: '  Owner@Acme.COM  ' });

    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { success: true });
    assert.equal(calls.length, 1);
    // The configured endpoint is used verbatim — it decides which experience's
    // apps and credits the customer gets.
    assert.equal(calls[0].url, ENDPOINT);
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(sent.email, 'owner@acme.com');
    assert.equal(sent.experienceType, 'DEMO_TYPE');
  });

  test('sends nothing but the email and the configured type', async () => {
    // The caller must not be able to steer where this lands or which
    // experience applies — the host on the outbound request is what resolves
    // the tenant, and it comes from config, never from the request.
    await post({ email: 'owner@acme.com', experienceType: 'SOMETHING_ELSE', alias: 'other' });
    assert.equal(calls[0].url, ENDPOINT);
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      email: 'owner@acme.com',
      experienceType: 'DEMO_TYPE',
    });
  });

  test('says it is unconfigured rather than reporting a network failure', async () => {
    const res = await post({ email: 'owner@acme.com' }, {}, freshIp(), { ASSETS });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /not configured/i);
    assert.equal(calls.length, 0);
  });

  test('refuses a bad address without calling upstream', async () => {
    for (const email of ['nope', '', 'a@b', null, 42]) {
      calls = [];
      const res = await post({ email });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(email)}`);
      assert.equal(calls.length, 0, 'must not reach upstream');
    }
  });

  test('refuses a body that is not JSON', async () => {
    const res = await post('not json at all');
    assert.equal(res.status, 400);
    assert.equal(calls.length, 0);
  });

  test('rejects anything but POST', async () => {
    const res = await worker.default.fetch(
      new Request('https://agentaction.online/api/signup', { method: 'GET' }),
      ENV,
    );
    assert.equal(res.status, 405);
  });

  test('passes a 4xx from upstream through, so "already registered" is not a server fault', async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: 'An account already exists for that email.' }), { status: 409 });

    const res = await post({ email: 'owner@acme.com' });

    assert.equal(res.status, 409);
    assert.match((await res.json()).error, /already exists/);
  });

  test('does not claim success when upstream says 200 but success:false', async () => {
    // The endpoint can answer 200 with success:false; treating any 2xx as
    // signed-up would tell someone their account exists when it does not.
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ success: false, error: 'Signups are paused.' }), { status: 200 });

    const res = await post({ email: 'owner@acme.com' });

    assert.notEqual(res.status, 200);
    assert.match((await res.json()).error, /paused/);
  });

  test('survives upstream answering HTML instead of JSON', async () => {
    // A proxy 502 answers with an error page; an unguarded .json() would throw
    // and surface a parser message to the visitor as if it were our copy.
    globalThis.fetch = async () => new Response('<html>502 Bad Gateway</html>', { status: 502 });

    const res = await post({ email: 'owner@acme.com' });

    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /try again/i);
  });

  test('says so when upstream cannot be reached at all', async () => {
    globalThis.fetch = async () => { throw new Error('network down'); };

    const res = await post({ email: 'owner@acme.com' });

    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /could not reach/i);
  });

  test('rate limits one IP without affecting another', async () => {
    let last;
    for (let i = 0; i < 7; i += 1) {
      last = await post({ email: `a${i}@acme.com` }, {}, '198.51.100.7');
    }
    assert.equal(last.status, 429);

    // A different visitor is unaffected — a single shared counter would lock
    // out a whole office sharing one egress IP.
    const other = await post({ email: 'someone@else.com' }, {}, '198.51.100.8');
    assert.equal(other.status, 200);
  });

  test('a typo does not spend the allowance', async () => {
    // The limiter runs after validation on purpose. Counting rejected input
    // would let five mistyped addresses lock someone out of a signup form.
    for (let i = 0; i < 9; i += 1) {
      const bad = await post({ email: 'not-an-email' }, {}, '198.51.100.9');
      assert.equal(bad.status, 400);
    }
    const good = await post({ email: 'owner@acme.com' }, {}, '198.51.100.9');
    assert.equal(good.status, 200);
  });
});

describe('everything else is the site', { skip: available ? false : 'needs a TS loader' }, () => {
  test('a normal page request goes to the asset handler, not the API', async () => {
    const res = await worker.default.fetch(new Request('https://agentaction.online/privacy'), ENV);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'the site');
    assert.equal(calls.length, 0);
  });
});
