const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

// The session event log is off by default (ADR-0008). Its only switch is the
// post-production URL, which an operator sets deliberately (userData/.env or
// the shell). A release must never ship that switch: not as a release-managed
// key, not in the packaged .env, not in the packaged default config.
const OPT_IN_ENV_KEY = "POSTPRO_API_URL";

test("the release workflows never write the session-log opt-in key", () => {
  const workflowDir = path.join(root, ".github", "workflows");
  for (const name of fs.readdirSync(workflowDir)) {
    const source = fs.readFileSync(path.join(workflowDir, name), "utf8");
    assert.equal(
      source.includes(OPT_IN_ENV_KEY),
      false,
      `${name} must not reference ${OPT_IN_ENV_KEY}`,
    );
    assert.equal(
      source.includes("--postpro-api-url"),
      false,
      `${name} must not pass --postpro-api-url`,
    );
  }
});

test("the opt-in key is not release-managed", () => {
  const source = read("src/electron/services/env-loader.ts");
  const match = source.match(
    /const RELEASE_MANAGED_ENV_KEYS = \[([\s\S]*?)\];/,
  );
  assert.ok(match, "RELEASE_MANAGED_ENV_KEYS must exist");
  assert.equal(match[1].includes(OPT_IN_ENV_KEY), false);
});

test("no tracked env or default config file carries the opt-in key", () => {
  const tracked = execFileSync("git", ["ls-files"], { cwd: root })
    .toString()
    .split("\n")
    .filter(
      (file) =>
        /(^|\/)\.env(\.|$)/.test(file) ||
        /^config\/.*\.json$/.test(file) ||
        /^electron-builder\./.test(file),
    );
  assert.ok(tracked.length > 0, "expected packaging inputs to check");
  for (const file of tracked) {
    const source = read(file);
    assert.equal(
      source.includes(OPT_IN_ENV_KEY) || /postpro/i.test(source),
      false,
      `${file} must not configure the post-production URL`,
    );
  }
});

test("the desktop app passes its environment to the bridge but never the opt-in as an argument", () => {
  const source = read("src/electron/services/bridge-process-contract.ts");
  assert.match(source, /\.\.\.processEnv,/);
  assert.equal(source.includes("postpro"), false);
});

// ADR-0011: the recording upload works in packaged releases without the
// opt-in key above. What keeps that safe is pinned here, next to the
// session-log guarantees it must not weaken.

test("the session-log switch reads only the post-production URL", () => {
  const source = read("apps/bridge/src/services/session-log/session-log-service.ts");
  const match = source.match(
    /export function isSessionLogEnabled\(\): boolean \{([\s\S]*?)\n\}/,
  );
  assert.ok(match, "isSessionLogEnabled must exist");
  const contextReads = [...match[1].matchAll(/getBridgeContext\(\)\.(\w+)/g)].map(
    (read) => read[1],
  );
  assert.deepEqual(contextReads, ["postproApiUrl"]);
  assert.equal(/platformApiUrl|process\.env/.test(match[1]), false);
  // No other file of the feature knows the platform address of the upload.
  const dir = path.join(root, "apps/bridge/src/services/session-log");
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) {
      continue;
    }
    assert.equal(
      fs.readFileSync(path.join(dir, name), "utf8").includes("platformApiUrl"),
      false,
      `${name} must not read the recording-upload platform address`,
    );
  }
});

test("the recording-upload command carries the single key `enabled`, strictly", () => {
  const source = read("apps/bridge/src/services/meeting/meeting-command-schemas.ts");
  const match = source.match(
    /export const MeetingRecordingUploadConfigureSchema = z\s*\.object\(\{([\s\S]*?)\}\)\s*\.(\w+)\(\);/,
  );
  assert.ok(match, "MeetingRecordingUploadConfigureSchema must exist");
  const keys = [...match[1].matchAll(/^\s*(\w+):/gm)].map((key) => key[1]);
  assert.deepEqual(keys, ["enabled"]);
  assert.match(match[1], /enabled: z\.boolean\(\),/);
  assert.equal(match[2], "strict");
});

test("the recording-upload hint is off by default", () => {
  const source = read("apps/bridge/src/services/postpro/recording-upload-store.ts");
  const match = source.match(
    /export const DEFAULT_RECORDING_UPLOAD_SETTINGS: RecordingUploadSettingsT = \{([\s\S]*?)\};/,
  );
  assert.ok(match, "DEFAULT_RECORDING_UPLOAD_SETTINGS must exist");
  assert.match(match[1], /enabled: false,/);
  // Every unreadable or invalid settings file falls back to that default.
  const load = source.match(/async load\(\): Promise<RecordingUploadSettingsT> \{([\s\S]*?)\n  \},/);
  assert.ok(load, "the settings loader must exist");
  assert.equal(/enabled: true/.test(source), false);
  assert.equal(
    (load[1].match(/DEFAULT_RECORDING_UPLOAD_SETTINGS/g) ?? []).length,
    2,
  );
});

test("the bridge reads the platform address only from the operator override and the release web app URL", () => {
  const source = read("apps/bridge/src/config.ts");
  const envKeys = [...source.matchAll(/process\.env(?:\.(\w+)|\[(\w+)\])/g)].map(
    (key) => key[1] ?? key[2],
  );
  const urlKeys = envKeys.filter((key) => /URL/.test(key) && key !== "RELAY_URL");
  assert.deepEqual([...new Set(urlKeys)].sort(), [
    "POSTPRO_API_URL",
    "RELEASE_PLATFORM_URL_ENV_KEY",
  ]);
  assert.match(
    source,
    /export const RELEASE_PLATFORM_URL_ENV_KEY = "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL";/,
  );
  // The release value has to pass the URL guard before it is used.
  const resolver = source.match(
    /export function resolvePlatformApiUrl\(([\s\S]*?)\n\}/,
  );
  assert.ok(resolver, "resolvePlatformApiUrl must exist");
  assert.match(resolver[1], /parseGuardedUrl\(value\)/);
});
