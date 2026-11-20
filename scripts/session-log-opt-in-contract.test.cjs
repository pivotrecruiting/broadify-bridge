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
