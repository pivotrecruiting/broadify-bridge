const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

// Which web app a packaged build opens after the bridge start depends on the
// release channel: RC builds talk to the dev relay and must open the dev web
// app, stable builds open production. Both are plain constants in the
// workflows (public URLs, no secret needed); this contract pins them and the
// fact that the bridge treats the resulting key as release-managed.
const STABLE_WEBAPP_URL = "https://app.broadify.de";
const RC_WEBAPP_URL = "https://studio-control-git-dev-broadify.vercel.app";
const WEBAPP_ENV_KEY = "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL";

const hasBash = (() => {
  try {
    execFileSync("bash", ["-c", "true"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Extracts the `run: |` script of the named workflow step without a YAML
 * parser: everything indented deeper than the `run:` line belongs to it.
 */
function extractRunBlock(workflowSource, stepName) {
  const lines = workflowSource.split("\n");
  const nameIdx = lines.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  assert.notEqual(nameIdx, -1, `step "${stepName}" must exist`);
  let runIdx = -1;
  for (let i = nameIdx + 1; i < lines.length; i += 1) {
    if (/^\s*- name: /.test(lines[i])) {
      break;
    }
    if (/^\s*run: \|\s*$/.test(lines[i])) {
      runIdx = i;
      break;
    }
  }
  assert.notEqual(runIdx, -1, `step "${stepName}" must have a run block`);
  const runIndent = lines[runIdx].match(/^\s*/)[0].length;
  const body = [];
  for (let i = runIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= runIndent) {
      break;
    }
    body.push(line.slice(runIndent + 2));
  }
  return body.join("\n");
}

function parseDotenv(source) {
  const result = {};
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    assert.ok(eq > 0, `unexpected env line: ${rawLine}`);
    result[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return result;
}

const FAKE_SECRETS = {
  RELAY_URL: "https://relay.stable.example.test",
  BRIDGE_RELAY_JWKS_URL: "https://relay.stable.example.test/jwks",
  RELAY_URL_RC: "https://relay.rc.example.test",
  BRIDGE_RELAY_JWKS_URL_RC: "https://relay.rc.example.test/jwks",
};

/**
 * Runs the channel-resolution step and then the packaging step of a workflow
 * the way GitHub Actions would: step one appends to $GITHUB_ENV, step two
 * sees those values in its environment and writes apps/bridge/dist/.env.
 *
 * @returns Parsed packaged .env.
 */
function runResolveAndPrepare({ workflow, resolveStep, refName }) {
  const source = read(workflow);
  const resolveScript = extractRunBlock(source, resolveStep);
  const prepareScript = extractRunBlock(
    source,
    "Prepare Bridge config for packaging",
  );

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-webapp-url-"));
  try {
    fs.mkdirSync(path.join(workDir, "config"));
    fs.writeFileSync(path.join(workDir, "config", "default.json"), "{}\n");
    const githubEnvPath = path.join(workDir, "github.env");
    fs.writeFileSync(githubEnvPath, "");

    const baseEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...FAKE_SECRETS,
      GITHUB_REF_NAME: refName,
      GITHUB_ENV: githubEnvPath,
    };
    execFileSync("bash", ["-c", resolveScript], {
      cwd: workDir,
      env: baseEnv,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const resolved = parseDotenv(fs.readFileSync(githubEnvPath, "utf8"));
    execFileSync("bash", ["-c", prepareScript], {
      cwd: workDir,
      env: { ...baseEnv, ...resolved },
      stdio: ["ignore", "ignore", "pipe"],
    });
    const packaged = parseDotenv(
      fs.readFileSync(path.join(workDir, "apps", "bridge", "dist", ".env"), "utf8"),
    );
    return { resolved, packaged };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

test(
  "release workflow packages the dev web app URL for RC tags",
  { skip: !hasBash && "bash is required to execute the workflow steps" },
  () => {
    const { resolved, packaged } = runResolveAndPrepare({
      workflow: ".github/workflows/release.yml",
      resolveStep: "Resolve release channel and relay config",
      refName: "v0.27.3-rc.22",
    });
    assert.equal(resolved.BROADIFY_UPDATER_CHANNEL, "rc");
    assert.equal(resolved.RESOLVED_WEBAPP_URL, RC_WEBAPP_URL);
    assert.equal(packaged.BROADIFY_UPDATER_CHANNEL, "rc");
    assert.equal(packaged.RELAY_URL, FAKE_SECRETS.RELAY_URL_RC);
    assert.equal(packaged[WEBAPP_ENV_KEY], RC_WEBAPP_URL);
  },
);

test(
  "release workflow packages the production web app URL for stable tags",
  { skip: !hasBash && "bash is required to execute the workflow steps" },
  () => {
    const { resolved, packaged } = runResolveAndPrepare({
      workflow: ".github/workflows/release.yml",
      resolveStep: "Resolve release channel and relay config",
      refName: "v0.27.3",
    });
    assert.equal(resolved.BROADIFY_UPDATER_CHANNEL, "latest");
    assert.equal(resolved.RESOLVED_WEBAPP_URL, STABLE_WEBAPP_URL);
    assert.equal(packaged.BROADIFY_UPDATER_CHANNEL, "latest");
    assert.equal(packaged.RELAY_URL, FAKE_SECRETS.RELAY_URL);
    assert.equal(packaged[WEBAPP_ENV_KEY], STABLE_WEBAPP_URL);
  },
);

test(
  "test-release workflow packages the dev web app URL",
  { skip: !hasBash && "bash is required to execute the workflow steps" },
  () => {
    const { packaged } = runResolveAndPrepare({
      workflow: ".github/workflows/test-release.yml",
      resolveStep: "Resolve test release relay config",
      refName: "test-release",
    });
    assert.equal(packaged.BROADIFY_UPDATER_CHANNEL, "rc");
    assert.equal(packaged[WEBAPP_ENV_KEY], RC_WEBAPP_URL);
  },
);

test("the packaged web app URL key is release-managed in the env loader", () => {
  const envLoader = read("src/electron/services/env-loader.ts");
  const match = envLoader.match(
    /const RELEASE_MANAGED_ENV_KEYS = \[([\s\S]*?)\];/,
  );
  assert.ok(match, "RELEASE_MANAGED_ENV_KEYS must be defined");
  const keys = [...match[1].matchAll(/"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  // A userData/.env seeded by a stable install must not keep an RC build on
  // the production web app after the channel switch.
  assert.ok(
    keys.includes(WEBAPP_ENV_KEY),
    `${WEBAPP_ENV_KEY} must be release-managed (found: ${keys.join(", ")})`,
  );
  for (const key of ["BROADIFY_UPDATER_CHANNEL", "RELAY_URL", "BRIDGE_RELAY_JWKS_URL"]) {
    assert.ok(keys.includes(key), `${key} must stay release-managed`);
  }
});

test("the desktop main keeps the production web app as the packaged default", () => {
  const main = read("src/electron/main.ts");
  assert.match(
    main,
    /isDev\(\) \? "http:\/\/localhost:3000" : "https:\/\/app\.broadify\.de"/,
  );
});
