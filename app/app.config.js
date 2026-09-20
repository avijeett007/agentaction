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

module.exports = ({ config }) => {
  const { owner, projectId } = easIdentity();
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
