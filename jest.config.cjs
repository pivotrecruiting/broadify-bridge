/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/apps/bridge/src"],
  testMatch: ["**/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.cjs"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "apps/bridge/src/**/*.ts",
    "!**/*.test.ts",
    "!**/*.d.ts",
  ],
  extensionsToTreatAsEsm: [".ts"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: true,
        tsconfig: "<rootDir>/tsconfig.test.json",
      },
    ],
  },
  // Some tests (e.g. main.test.ts) load modules that register app/process listeners.
  // Those keep the event loop alive; forceExit ensures Jest exits after the run.
  forceExit: true,
};
