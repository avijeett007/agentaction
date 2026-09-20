/**
 * Unit tests only — no device, no simulator, no network.
 *
 * A single platform preset (ios) rather than jest-expo's multi-platform one:
 * nothing under test is platform-specific, and running every suite four times
 * buys nothing.
 */
module.exports = {
  preset: 'jest-expo/ios',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  // Mirrors jest-expo's default list, plus @noble — its packages ship as ESM
  // and would otherwise reach the CommonJS sandbox untransformed.
  transformIgnorePatterns: [
    '/node_modules/(?!(.pnpm|react-native|@react-native|@react-native-community|expo|@expo|@expo-google-fonts|@noble|react-navigation|@react-navigation|native-base|standard-navigation))',
    '/node_modules/react-native-reanimated/plugin/',
    '/node_modules/@react-native/babel-preset/',
  ],
  clearMocks: true,
};
