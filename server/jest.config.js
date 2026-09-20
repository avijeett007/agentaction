/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  globalSetup: '<rootDir>/test/globalSetup.ts',
  setupFilesAfterEnv: ['<rootDir>/test/setup.ts'],
  testTimeout: 15000,
  clearMocks: true,
  // Every suite shares one SQLite file, so they must not run in parallel.
  // Pinned here as well as in `npm test`, so a bare `npx jest` behaves too.
  maxWorkers: 1,
};
