const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_HELPER_DIRS,
  WINDOWS_VC_RUNTIME_STAGING_DIR,
  getWindowsVcRuntimeResourceEntries,
  getWindowsVcRuntimePackagedPaths,
  getWindowsVcRuntimeStagedPaths,
} = require("./lib/windows-vc-runtime.cjs");
const {
  WINDOWS_NATIVE_RESOURCES,
} = require("./sign-windows-native-resources.cjs");

const repoRoot = path.join(__dirname, "..");
// Normalise CRLF: Windows runners check out with autocrlf, and the tests
// below match literal "\n" sequences in workflow and script text.
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");

// The Microsoft.VC143.CRT folder of the VS 2022 redistributable
// (<VCToolsRedistDir>\x64\Microsoft.VC143.CRT). This is the complete,
// redistributable CRT set; the UCRT is an OS component and is not shipped.
const EXPECTED_DLLS = [
  "concrt140.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "vccorlib140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
];

/**
 * Loads electron-builder.config.cjs in a child process with process.platform
 * forced to win32 so the Windows branch of the config is evaluated the same
 * way it is on the release runner, and returns config.win.extraResources.
 */
function loadWindowsExtraResources() {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const config = require(${JSON.stringify(
      path.join(repoRoot, "electron-builder.config.cjs"),
    )});
    process.stdout.write(JSON.stringify(config.win.extraResources));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("ships exactly the Microsoft.VC143.CRT DLL set, each listed once", () => {
  assert.deepEqual([...WINDOWS_VC_RUNTIME_DLLS], EXPECTED_DLLS);
  assert.equal(new Set(WINDOWS_VC_RUNTIME_DLLS).size, EXPECTED_DLLS.length);
  for (const dll of WINDOWS_VC_RUNTIME_DLLS) {
    assert.match(dll, /^[a-z0-9_]+\.dll$/);
  }
  assert.ok(Object.isFrozen(WINDOWS_VC_RUNTIME_DLLS));
});

test("targets the display-helper and meeting-helper folders as packaged", () => {
  assert.deepEqual(
    [...WINDOWS_VC_RUNTIME_HELPER_DIRS],
    ["native/display-helper", "native/meeting-helper"],
  );
  assert.equal(WINDOWS_VC_RUNTIME_STAGING_DIR, "build/windows-vc-runtime");
});

test("helper folders match where electron-builder packages the helper executables", () => {
  const extraResources = loadWindowsExtraResources();
  const helperExecutableDirs = extraResources
    .filter((entry) =>
      ["display-helper.exe", "meeting-helper.exe"].includes(
        path.posix.basename(entry.to),
      ),
    )
    .map((entry) => path.posix.dirname(entry.to));
  assert.deepEqual(helperExecutableDirs, [...WINDOWS_VC_RUNTIME_HELPER_DIRS]);
});

test("resource entries are deterministic and copy the full set into every helper folder", () => {
  const entries = getWindowsVcRuntimeResourceEntries();
  assert.deepEqual(entries, getWindowsVcRuntimeResourceEntries());
  assert.equal(entries.length, WINDOWS_VC_RUNTIME_HELPER_DIRS.length);
  entries.forEach((entry, index) => {
    assert.deepEqual(entry, {
      from: WINDOWS_VC_RUNTIME_STAGING_DIR,
      to: WINDOWS_VC_RUNTIME_HELPER_DIRS[index],
      filter: EXPECTED_DLLS,
    });
  });
});

test("packaged paths list every DLL exactly once per helper folder", () => {
  const packagedPaths = getWindowsVcRuntimePackagedPaths();
  assert.deepEqual(packagedPaths, getWindowsVcRuntimePackagedPaths());
  assert.equal(
    packagedPaths.length,
    EXPECTED_DLLS.length * WINDOWS_VC_RUNTIME_HELPER_DIRS.length,
  );
  assert.equal(new Set(packagedPaths).size, packagedPaths.length);
  for (const helperDir of WINDOWS_VC_RUNTIME_HELPER_DIRS) {
    for (const dll of EXPECTED_DLLS) {
      assert.ok(packagedPaths.includes(`${helperDir}/${dll}`));
    }
  }
  assert.deepEqual(
    getWindowsVcRuntimeStagedPaths(),
    EXPECTED_DLLS.map((dll) => `${WINDOWS_VC_RUNTIME_STAGING_DIR}/${dll}`),
  );
});

test("electron-builder packages the CRT entries for Windows", () => {
  const extraResources = loadWindowsExtraResources();
  for (const expected of getWindowsVcRuntimeResourceEntries()) {
    assert.ok(
      extraResources.some(
        (entry) => JSON.stringify(entry) === JSON.stringify(expected),
      ),
      `missing CRT extraResources entry for ${expected.to}`,
    );
  }
});

test("CRT DLLs stay out of the Azure re-signing set (they are Microsoft-signed)", () => {
  const signedSet = new Set(WINDOWS_NATIVE_RESOURCES);
  for (const packagedPath of getWindowsVcRuntimePackagedPaths()) {
    assert.ok(
      !signedSet.has(`resources/${packagedPath}`),
      `${packagedPath} must not be re-signed`,
    );
  }
});

test("list CLI prints the packaged, staged and DLL lists one per line", () => {
  const cli = path.join(__dirname, "list-windows-vc-runtime-paths.cjs");
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

  const packaged = run([]);
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.deepEqual(
    packaged.stdout.trimEnd().split("\n"),
    getWindowsVcRuntimePackagedPaths(),
  );

  const dlls = run(["--dlls"]);
  assert.equal(dlls.status, 0, dlls.stderr);
  assert.deepEqual(dlls.stdout.trimEnd().split("\n"), EXPECTED_DLLS);

  const staged = run(["--staged"]);
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(
    staged.stdout.trimEnd().split("\n"),
    getWindowsVcRuntimeStagedPaths(),
  );

  const unknown = run(["--bogus"]);
  assert.notEqual(unknown.status, 0);
});

test("dist:win stages the CRT after the meeting helper and before artifact verification", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["prepare:vc-runtime:windows"],
    /prepare-windows-vc-runtime\.ps1/,
  );
  const distWin = packageJson.scripts["dist:win"];
  const buildMeetingHelper = distWin.indexOf("npm run build:meeting-helper");
  const prepare = distWin.indexOf("npm run prepare:vc-runtime:windows");
  const verify = distWin.indexOf("verify-release-artifacts.sh");
  assert.ok(buildMeetingHelper >= 0);
  assert.ok(prepare > buildMeetingHelper);
  assert.ok(verify > prepare);
});

test("staging folder is gitignored and required by the release artifact check", () => {
  assert.match(read(".gitignore"), /^build\/windows-vc-runtime\/$/m);
  assert.match(
    read("scripts/verify-release-artifacts.sh"),
    /list-windows-vc-runtime-paths\.cjs"? --staged/,
  );
});

test("PowerShell scripts take the CRT list from the Node single source of truth", () => {
  for (const script of [
    "scripts/smoke-test-windows-msi.ps1",
    "scripts/smoke-test-windows-nsis.ps1",
    "scripts/verify-windows-release-signatures.ps1",
  ]) {
    assert.match(read(script), /list-windows-vc-runtime-paths\.cjs/, script);
  }
  const prepare = read("scripts/prepare-windows-vc-runtime.ps1");
  assert.match(prepare, /list-windows-vc-runtime-paths\.cjs/);
  assert.match(prepare, /VCToolsRedistDir/);
  assert.match(prepare, /vswhere/);
  assert.match(prepare, /Microsoft\.VC143\.CRT/);

  const verify = read("scripts/verify-windows-release-signatures.ps1");
  assert.match(verify, /Get-AuthenticodeSignature/);
  assert.match(verify, /Microsoft Corporation/);
});

test("release workflows gate the Windows build on helper DLL dependencies", () => {
  for (const workflow of [
    ".github/workflows/release.yml",
    ".github/workflows/test-release.yml",
  ]) {
    const text = read(workflow);
    const build = text.indexOf("- name: Build Electron App\n");
    const gate = text.indexOf("verify-windows-native-dependencies.cjs");
    assert.ok(build >= 0, workflow);
    assert.ok(gate > build, `${workflow}: dependency gate must follow the build`);
  }
});
