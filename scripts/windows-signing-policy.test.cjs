const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  AZURE_CODE_SIGNING_ENV_VARS,
  UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV,
  isWindowsTargetRequested,
  resolveWindowsSigningPolicy,
} = require("./lib/resolve-windows-signing-policy.cjs");

const repoRoot = path.join(__dirname, "..");

const COMPLETE_AZURE_ENV = {
  AZURE_CODE_SIGNING_PUBLISHER_NAME: "CN=Broadify",
  AZURE_CODE_SIGNING_ENDPOINT: "https://weu.codesigning.azure.net",
  AZURE_CODE_SIGNING_ACCOUNT_NAME: "broadify-signing",
  AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME: "broadify-public-trust",
};

/**
 * Returns a copy of process.env without any Azure signing variables and without
 * the unsigned-build opt-out, so spawned processes start from a clean baseline.
 */
function baseEnvWithoutSigning() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AZURE_")) continue;
    if (key === UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV) continue;
    env[key] = value;
  }
  return env;
}

test("exports the four Azure Trusted Signing variable names", () => {
  assert.deepEqual(AZURE_CODE_SIGNING_ENV_VARS, [
    "AZURE_CODE_SIGNING_PUBLISHER_NAME",
    "AZURE_CODE_SIGNING_ENDPOINT",
    "AZURE_CODE_SIGNING_ACCOUNT_NAME",
    "AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME",
  ]);
  assert.equal(
    UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV,
    "BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD",
  );
});

test("detects --win, -w, --windows and --win=x64", () => {
  assert.equal(isWindowsTargetRequested(["--win"]), true);
  assert.equal(isWindowsTargetRequested(["-w"]), true);
  assert.equal(isWindowsTargetRequested(["--windows"]), true);
  assert.equal(isWindowsTargetRequested(["--win=x64"]), true);
  assert.equal(isWindowsTargetRequested(["--windows=nsis"]), true);
  assert.equal(
    isWindowsTargetRequested([
      "/usr/bin/node",
      "cli.js",
      "--config",
      "electron-builder.config.cjs",
      "--win",
      "--x64",
    ]),
    true,
  );

  assert.equal(isWindowsTargetRequested([]), false);
  assert.equal(isWindowsTargetRequested(["--mac", "--arm64"]), false);
  assert.equal(isWindowsTargetRequested(["--linux", "--x64"]), false);
  // Values that merely contain "win" must not count as a Windows target.
  assert.equal(isWindowsTargetRequested(["--winter"]), false);
  assert.equal(isWindowsTargetRequested(["win"]), false);
  assert.equal(isWindowsTargetRequested(["--config", "win.cjs"]), false);
});

test("fails fast when a Windows build is requested without complete Azure config", () => {
  assert.throws(
    () => resolveWindowsSigningPolicy({ env: {}, argv: ["--win"] }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "Windows signing is not configured (missing: AZURE_CODE_SIGNING_PUBLISHER_NAME, AZURE_CODE_SIGNING_ENDPOINT, AZURE_CODE_SIGNING_ACCOUNT_NAME, AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME). Set BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD=1 for a local unsigned build.",
      );
      return true;
    },
  );

  // A partially configured environment lists only the missing names.
  assert.throws(
    () =>
      resolveWindowsSigningPolicy({
        env: {
          ...COMPLETE_AZURE_ENV,
          AZURE_CODE_SIGNING_ENDPOINT: "   ",
          AZURE_CODE_SIGNING_ACCOUNT_NAME: undefined,
        },
        argv: ["-w"],
      }),
    /missing: AZURE_CODE_SIGNING_ENDPOINT, AZURE_CODE_SIGNING_ACCOUNT_NAME\)/,
  );

  // Any opt-out value other than "1" does not unlock the unsigned build.
  assert.throws(
    () =>
      resolveWindowsSigningPolicy({
        env: { [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "true" },
        argv: ["--win=x64"],
      }),
    /Windows signing is not configured/,
  );
});

test("allows an unsigned Windows build only with explicit opt-out", () => {
  assert.deepEqual(
    resolveWindowsSigningPolicy({
      env: { [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1" },
      argv: ["--win"],
    }),
    { mode: "unsigned_opt_out", missing: [...AZURE_CODE_SIGNING_ENV_VARS] },
  );

  assert.deepEqual(
    resolveWindowsSigningPolicy({
      env: {
        ...COMPLETE_AZURE_ENV,
        AZURE_CODE_SIGNING_PUBLISHER_NAME: "",
        [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1",
      },
      argv: ["--windows"],
    }),
    {
      mode: "unsigned_opt_out",
      missing: ["AZURE_CODE_SIGNING_PUBLISHER_NAME"],
    },
  );
});

test("does not fail when no Windows target is requested", () => {
  assert.deepEqual(
    resolveWindowsSigningPolicy({ env: {}, argv: ["--mac", "--arm64"] }),
    { mode: "not_applicable", missing: [...AZURE_CODE_SIGNING_ENV_VARS] },
  );
  assert.deepEqual(resolveWindowsSigningPolicy({ env: {}, argv: [] }), {
    mode: "not_applicable",
    missing: [...AZURE_CODE_SIGNING_ENV_VARS],
  });
  // The opt-out is irrelevant when no Windows target is requested.
  assert.deepEqual(
    resolveWindowsSigningPolicy({
      env: { [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1" },
      argv: ["--linux"],
    }),
    { mode: "not_applicable", missing: [...AZURE_CODE_SIGNING_ENV_VARS] },
  );
});

test("resolves azure mode when all vars are set", () => {
  assert.deepEqual(
    resolveWindowsSigningPolicy({ env: COMPLETE_AZURE_ENV, argv: ["--win"] }),
    { mode: "azure" },
  );
  // Complete Azure config always wins over the opt-out.
  assert.deepEqual(
    resolveWindowsSigningPolicy({
      env: { ...COMPLETE_AZURE_ENV, [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1" },
      argv: ["--win"],
    }),
    { mode: "azure" },
  );
  // Complete config is honoured for non-Windows invocations too (as before).
  assert.deepEqual(
    resolveWindowsSigningPolicy({ env: COMPLETE_AZURE_ENV, argv: ["--mac"] }),
    { mode: "azure" },
  );
});

test("does not mutate the input env or argv", () => {
  const env = { [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1" };
  const argv = ["--win"];
  const envSnapshot = { ...env };
  const argvSnapshot = [...argv];

  resolveWindowsSigningPolicy({ env, argv });

  assert.deepEqual(env, envSnapshot);
  assert.deepEqual(argv, argvSnapshot);
});

test("electron-builder config refuses a Windows build without Azure config", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./electron-builder.config.cjs')", "--", "--win"],
    { cwd: repoRoot, encoding: "utf8", env: baseEnvWithoutSigning() },
  );

  assert.notEqual(result.status, 0, "expected the config to fail fast");
  assert.match(result.stderr, /Windows signing is not configured/);
  assert.match(result.stderr, /BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD=1/);
});

test("electron-builder config allows a Windows build with the explicit opt-out", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const config = require('./electron-builder.config.cjs'); process.stdout.write(JSON.stringify({ hasAzure: 'azureSignOptions' in config.win, publisherName: config.win.publisherName ?? null }));",
      "--",
      "--win",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...baseEnvWithoutSigning(),
        [UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV]: "1",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    hasAzure: false,
    publisherName: null,
  });
  assert.match(result.stderr, /\[Signing\] Windows signing policy: unsigned_opt_out/);
  assert.match(result.stderr, /missing: AZURE_CODE_SIGNING_PUBLISHER_NAME/);
});

test("electron-builder config injects Azure signing when fully configured", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const config = require('./electron-builder.config.cjs'); process.stdout.write(JSON.stringify({ publisherName: config.win.publisherName, azure: config.win.azureSignOptions }));",
      "--",
      "--win",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...baseEnvWithoutSigning(), ...COMPLETE_AZURE_ENV },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.publisherName, COMPLETE_AZURE_ENV.AZURE_CODE_SIGNING_PUBLISHER_NAME);
  assert.equal(parsed.azure.endpoint, COMPLETE_AZURE_ENV.AZURE_CODE_SIGNING_ENDPOINT);
  assert.equal(
    parsed.azure.codeSigningAccountName,
    COMPLETE_AZURE_ENV.AZURE_CODE_SIGNING_ACCOUNT_NAME,
  );
  assert.equal(
    parsed.azure.certificateProfileName,
    COMPLETE_AZURE_ENV.AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME,
  );
  assert.equal("publisherName" in parsed.azure, false);
  assert.match(result.stderr, /\[Signing\] Windows signing policy: azure$/m);
});

test("electron-builder config keeps stdout clean and loads without a Windows target", () => {
  const result = spawnSync(
    process.execPath,
    ["-e", "require('./electron-builder.config.cjs')", "--", "--mac", "--arm64"],
    { cwd: repoRoot, encoding: "utf8", env: baseEnvWithoutSigning() },
  );

  assert.equal(result.status, 0, result.stderr);
  // stdout is consumed by scripts/resolve-windows-install-directory-name.cjs
  // (and from there by smoke-test-windows-nsis.ps1), so the policy log must
  // never land there.
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /\[Signing\] Windows signing policy: not_applicable/);
});
