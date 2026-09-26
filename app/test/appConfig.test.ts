/**
 * A release must not ship with push silently switched off.
 *
 * This is 0.1.0 written down as a test. The EAS project id lives outside the
 * public app.json — in a gitignored `eas.local.json`, or in EAS_PROJECT_ID. The
 * local file never reaches the EAS builder, the variable had not been set there,
 * and so the config omitted `extra.eas.projectId` and carried on. The APK went
 * out unable to mint a push token, and because the id is baked in at build time
 * no amount of tapping "Retry registration" on the phone could repair it.
 *
 * The first case is the one that matters. The rest exist so the guard cannot be
 * "fixed" by making every build fail: a fork that has never run `eas init` must
 * still be able to build and run the app.
 */

const CONFIG_PATH = '../app.config';

/**
 * Load app.config.js fresh and return a caller that runs it under `env`.
 *
 * The environment has to still be in place when the exported function RUNS, not
 * merely when the module is required — app.config.js reads process.env inside
 * the call. Restoring it too early made every one of these pass against a broken
 * guard the first time round.
 */
function loadConfig(env: Record<string, string | undefined>) {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require(CONFIG_PATH) as (a: { config: Record<string, unknown> }) => Record<string, any>;

  return (arg: { config: Record<string, unknown> }) => {
    const saved = { ...process.env };
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return mod(arg);
    } finally {
      process.env = saved;
    }
  };
}

const BASE = { config: { name: 'AgentAction', extra: {}, android: {} } };

// The real file sits beside eas.local.json; a developer machine may have one.
// These tests are about the environment path, so pretend it is never there.
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn(() => false),
  readFileSync: jest.requireActual('fs').readFileSync,
}));

describe('a release build without an EAS project id', () => {
  it('refuses to build, rather than shipping push permanently off', () => {
    const cfg = loadConfig({
      EAS_BUILD_PROFILE: 'release-apk',
      EAS_PROJECT_ID: undefined,
      EAS_OWNER: undefined,
    });

    expect(() => cfg(BASE)).toThrow(/push notifications/i);
    expect(() => cfg(BASE)).toThrow(/release-apk/);
  });

  it('refuses for the production profile too', () => {
    const cfg = loadConfig({ EAS_BUILD_PROFILE: 'production', EAS_PROJECT_ID: undefined });
    expect(() => cfg(BASE)).toThrow(/push notifications/i);
  });
});

describe('everything that is not a release', () => {
  it('still builds without an id — a fork that has not run `eas init`', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = loadConfig({ EAS_BUILD_PROFILE: undefined, EAS_PROJECT_ID: undefined });

    const out = cfg(BASE);

    expect(out.extra.eas).toBeUndefined();
    // …but it says so, rather than leaving them to find out from the phone.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cannot receive push/i));
    warn.mockRestore();
  });

  it('still builds for a preview/development profile', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cfg = loadConfig({ EAS_BUILD_PROFILE: 'preview', EAS_PROJECT_ID: undefined });
    expect(() => cfg(BASE)).not.toThrow();
  });
});

describe('when the id is present', () => {
  it('puts it where expo-notifications looks for it', () => {
    const cfg = loadConfig({ EAS_BUILD_PROFILE: 'release-apk', EAS_PROJECT_ID: 'proj-123' });

    const out = cfg(BASE);

    // lib/push.ts reads exactly this path.
    expect(out.extra.eas.projectId).toBe('proj-123');
  });

  it('carries the owner through when one is set', () => {
    const cfg = loadConfig({ EAS_PROJECT_ID: 'proj-123', EAS_OWNER: 'someone' });
    expect(cfg(BASE).owner).toBe('someone');
  });
});
