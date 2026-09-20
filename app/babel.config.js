/**
 * Metro finds this preset on its own, but jest-expo's platform presets hand
 * babel-jest only a `caller` and rely on a config file being present — without
 * this file the test run parses neither TypeScript nor React Native's Flow.
 */
module.exports = function (api) {
  api.cache(true);
  return { presets: ['babel-preset-expo'] };
};
