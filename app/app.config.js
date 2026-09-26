/**
 * Everything static lives in app.json; this file exists for one reason.
 *
 * `google-services.json` carries a Firebase project's identifiers, so it is
 * gitignored — and EAS only uploads files that git tracks, which meant the
 * build failed at the prepare step with the file simply absent. It is stored
 * as an EAS file secret instead: at build time `GOOGLE_SERVICES_JSON` holds a
 * path to the decrypted copy, and that is what the Android build should read.
 *
 * Locally the variable is unset and the developer's own copy beside this file
 * is used, so `npx expo run:android` still works without a round trip to EAS.
 */
const fs = require('fs');
const path = require('path');

/**
 * Which Expo account and project this checkout builds against.
 *
 * Deliberately not in app.json: that file is public, and whose EAS project a
 * build belongs to is an installation detail, not part of the app. Anyone
 * cloning this runs `eas init` and gets their own. Ours lives in an ignored
 * `eas.local.json`, or in EAS_OWNER / EAS_PROJECT_ID.
 */
function easIdentity() {
  const local = path.join(__dirname, 'eas.local.json');
  if (fs.existsSync(local)) {
    try {
      return JSON.parse(fs.readFileSync(local, 'utf8'));
    } catch {
      // A malformed local file must not silently build against the wrong project.
      throw new Error('eas.local.json is not valid JSON');
    }
  }
  return { owner: process.env.EAS_OWNER, projectId: process.env.EAS_PROJECT_ID };
}

/**
 * A build people will install must be able to ask for a push token.
 *
 * `expo-notifications` cannot mint one without an EAS project id, and the id is
 * baked into the binary at build time — so a release built without it ships push
 * permanently off, and no amount of retrying on the phone can repair it. 0.1.0
 * went out exactly that way: the id lives in a gitignored `eas.local.json` which
 * never reaches the EAS builder, and nobody had set EAS_PROJECT_ID there either.
 * The config simply omitted the field and carried on.
 *
 * So a RELEASE build now stops instead. Every other build keeps working without
 * an id — a fork running `expo run:android`, a simulator build, anyone who has
 * not run `eas init` yet — because for them a missing token costs a buzz, not a
 * shipped defect. `EAS_BUILD_PROFILE` is set only by the EAS builder, which is
 * what makes "is this a release?" answerable here at all.
 */
function assertReleaseHasProjectId(projectId) {
  const profile = process.env.EAS_BUILD_PROFILE;
  if (projectId) return;

  const isRelease = !!profile && /^(release|production)/i.test(profile);
  if (isRelease) {
    throw new Error(
      `No EAS project id, so build profile "${profile}" would ship with push notifications ` +
        'permanently disabled. Set EAS_PROJECT_ID (and EAS_OWNER) as environment variables on ' +
        'the EAS project, or add app/eas.local.json, then build again. ' +
        'See docs/releasing.md.',
    );
  }
  // Not a release: say it plainly and carry on.
  console.warn(
    '[agentaction] No EAS project id — this build cannot receive push notifications. ' +
      'Run `eas init`, or set EAS_PROJECT_ID. Approvals still arrive; the app polls.',
  );
}

module.exports = ({ config }) => {
  const { owner, projectId } = easIdentity();
  assertReleaseHasProjectId(projectId);
  return {
    ...config,
    ...(owner ? { owner } : {}),
    android: {
      ...config.android,
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
    },
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...(config.extra && config.extra.eas), projectId } } : {}),
    },
  };
};
