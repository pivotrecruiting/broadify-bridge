const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const pgmHelper = require("./lib/windows-pgm-helper.cjs");
const vcRuntime = require("./lib/windows-vc-runtime.cjs");
const signWindowsNativeResources = require("./sign-windows-native-resources.cjs");
const {
  verifyNativeDependencies,
} = require("./verify-windows-native-dependencies.cjs");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009, point 8 / docs/bridge/features/pgm-live-preview-windows.md:
// pgm-helper.exe is built and packaged only behind the build switch
// BROADIFY_PGM_WINDOWS=1, which is off by default and which no release
// workflow sets. Without the switch a Windows release packages, signs and
// verifies what it did before the helper existed; with it, one switch moves
// packaging, signing, the VC runtime folder and the artifact check together.
//
// These tests run inside every release build (dist:win -> npm run build ->
// npm run test), also inside a build that has the switch set. The list checks
// therefore never rely on the ambient value: each one passes its own. The one
// place that reads it does so on purpose: whether test-release.yml may carry
// the switch (see the test of the release workflows).
const SWITCH = "BROADIFY_PGM_WINDOWS";
const OFF = Object.freeze({});
const ON = Object.freeze({ [SWITCH]: "1" });

const PGM_HELPER_SOURCE = "apps/bridge/native/pgm-helper/pgm-helper.exe";
const PGM_HELPER_DIR = "native/pgm-helper";
const PGM_HELPER_PACKAGED = `${PGM_HELPER_DIR}/pgm-helper.exe`;
const PGM_HELPER_SIGNED = `resources/${PGM_HELPER_PACKAGED}`;

/** Environment for a child process with the switch forced to `value` (undefined = unset). */
function childEnv(value) {
  const env = { ...process.env, BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD: "1" };
  for (const key of Object.keys(env)) {
    // Windows treats environment names case-insensitively.
    if (key.toUpperCase() === SWITCH) {
      delete env[key];
    }
  }
  if (value !== undefined) {
    env[SWITCH] = value;
  }
  return env;
}

/** Runs `fn` with the switch of this process forced to `value` (undefined = unset). */
async function withSwitch(value, fn) {
  const previous = process.env[SWITCH];
  if (value === undefined) {
    delete process.env[SWITCH];
  } else {
    process.env[SWITCH] = value;
  }
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[SWITCH];
    } else {
      process.env[SWITCH] = previous;
    }
  }
}

/**
 * Loads electron-builder.config.cjs in a child process with process.platform
 * forced to win32, the way the release runner evaluates it.
 */
function loadBuilderConfig(value) {
  const script = `
    Object.defineProperty(process, "platform", { value: "win32" });
    const config = require(${JSON.stringify(path.join(root, "electron-builder.config.cjs"))});
    process.stdout.write(JSON.stringify({
      extraResources: config.extraResources,
      win: config.win.extraResources,
      mac: config.mac.extraResources,
      afterSign: config.afterSign || null,
    }));
  `;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: root,
    encoding: "utf8",
    env: childEnv(value),
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function runListCli(args, value) {
  return spawnSync(
    process.execPath,
    [path.join(__dirname, "list-windows-pgm-helper-paths.cjs"), ...args],
    { encoding: "utf8", env: childEnv(value) },
  );
}

const mentionsPgmHelper = (value) => JSON.stringify(value).includes("pgm-helper");

/** The steps of a workflow job, each starting at its `- name:` line. */
function workflowSteps(source) {
  return source.split(/\n(?=      - name: )/).slice(1);
}

function findStep(source, name) {
  const steps = workflowSteps(source).filter((step) =>
    step.startsWith(`      - name: ${name}\n`),
  );
  assert.equal(steps.length, 1, `step "${name}" must exist exactly once`);
  return steps[0];
}

/** The `run: |` script of a step, without its indentation. */
function runBlock(step) {
  const lines = step.split("\n");
  const start = lines.findIndex((line) => /^\s+run: \|\s*$/.test(line));
  assert.notEqual(start, -1, "step must have a run block");
  const indent = lines[start].match(/^\s*/)[0].length;
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && line.match(/^\s*/)[0].length <= indent) {
      break;
    }
    body.push(line.trim() === "" ? "" : line.slice(indent + 2));
  }
  return body.join("\n").trimEnd();
}

// Any spelling of the name: Windows treats environment names
// case-insensitively, so `broadify_pgm_windows: "1"` in a workflow would set
// the switch on the Windows runner just the same.
const SWITCH_PATTERN = /BROADIFY_PGM_WINDOWS/i;

/** The branches an opt-in build may run from in CI (docs: "Opt-in-Build für die Sitzung am Gerät", Weg C). */
const OPT_IN_BUILD_REF = /^test-release\/pgm-windows/;

/** Source text without block and line comments (TypeScript, JavaScript). */
function stripCodeComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Non-comment lines that mention the switch other than as the step guard. */
function switchMentionsOutsideGuard(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.split(`env.${SWITCH} == '1'`).join(""))
    .filter((line) => SWITCH_PATTERN.test(line));
}

/**
 * What is wrong with the way a release workflow carries the build switch;
 * empty when nothing is. `env` is the environment the contract tests run in.
 *
 * - release.yml builds what customers install: it never carries the switch.
 * - test-release.yml publishes nothing. The opt-in build for the device
 *   session sets the switch there, and only like this: for the whole job
 *   (build, dependency gate, signature check and smoke tests each read it),
 *   in a build that runs these tests with the switch on, and - when the
 *   tests run in GitHub Actions - on a branch test-release/pgm-windows*.
 *   Any run without the switch, which includes every real release build,
 *   fails on such a line, so it cannot sit on dev; and a line that strayed
 *   onto another ref cannot produce a signed opt-in installer there.
 */
function switchRuleViolations({ workflow, source, env }) {
  const mentions = switchMentionsOutsideGuard(source);
  if (mentions.length === 0) {
    return [];
  }
  if (workflow !== "test-release.yml") {
    return [
      `${workflow} must not set ${SWITCH}; an opt-in build goes through test-release.yml on a branch test-release/pgm-windows`,
    ];
  }
  if (!pgmHelper.isWindowsPgmHelperEnabled(env)) {
    return [
      `test-release.yml sets ${SWITCH}: allowed only for an opt-in build on a branch test-release/pgm-windows (which runs these tests with the switch), never on dev or main`,
    ];
  }
  const violations = mentions
    .filter((line) => !/^      BROADIFY_PGM_WINDOWS: /.test(line))
    .map((line) => `set the switch for the whole job, as ${SWITCH}, not like this: ${line.trim()}`);
  if (env.GITHUB_ACTIONS && !OPT_IN_BUILD_REF.test(env.GITHUB_REF_NAME ?? "")) {
    violations.push(
      `test-release.yml sets ${SWITCH} on ${env.GITHUB_REF_NAME || "an unnamed ref"}: an opt-in build runs from a branch test-release/pgm-windows only`,
    );
  }
  return violations;
}

test("the build switch is on for exactly \"1\", like the build wrapper and CMake", () => {
  assert.equal(pgmHelper.WINDOWS_PGM_BUILD_SWITCH, SWITCH);
  assert.equal(pgmHelper.isWindowsPgmHelperEnabled(ON), true);
  for (const value of [undefined, "", "0", "true", "TRUE", "on", "yes", " 1", "1 ", "01", "2"]) {
    assert.equal(
      pgmHelper.isWindowsPgmHelperEnabled({ [SWITCH]: value }),
      false,
      `${JSON.stringify(value)} must not enable the helper`,
    );
  }
  assert.equal(pgmHelper.isWindowsPgmHelperEnabled(OFF), false);

  // The three places that decide use the same test, so the packaging lists
  // never ask for a helper the build skipped (or the other way round).
  assert.match(
    read("scripts/lib/windows-pgm-helper.cjs"),
    /return env\[WINDOWS_PGM_BUILD_SWITCH\] === "1";/,
  );
  assert.match(
    read("scripts/build-pgm-helper.sh"),
    /\[\[ "\$\{BROADIFY_PGM_WINDOWS:-\}" == "1" \]\]; then\n  BUILD_PS1=/,
  );
  assert.match(
    read("apps/bridge/native/live-stream/CMakeLists.txt"),
    /elseif\(WIN32 AND "\$ENV\{BROADIFY_PGM_WINDOWS\}" STREQUAL "1"\)/,
  );
});

test("without the switch the module contributes nothing", () => {
  for (const env of [OFF, { [SWITCH]: "0" }, { [SWITCH]: "true" }, { [SWITCH]: "" }]) {
    assert.deepEqual(pgmHelper.getWindowsPgmHelperResourceEntries(env), []);
    assert.deepEqual(pgmHelper.getWindowsPgmHelperSigningPaths(env), []);
    assert.deepEqual(pgmHelper.getWindowsPgmHelperVcRuntimeDirs(env), []);
    assert.deepEqual(pgmHelper.getWindowsPgmHelperPackagedPaths(env), []);
    assert.deepEqual(pgmHelper.getWindowsPgmHelperSourcePaths(env), []);
  }
});

test("without the switch the Windows package, signing list, VC runtime folders and dependency gate contain nothing of the helper", async () => {
  // Packaging: nothing of the helper in the Windows resources.
  const config = loadBuilderConfig(undefined);
  const windowsResources = [...config.extraResources, ...config.win];
  assert.deepEqual(windowsResources.filter(mentionsPgmHelper), []);
  // Also for values that are not exactly "1".
  assert.deepEqual(loadBuilderConfig("0"), config);
  assert.deepEqual(loadBuilderConfig("true"), config);

  // Signing: exactly the fixed list.
  const appOutDir = path.join(os.tmpdir(), "broadify-app-out");
  assert.deepEqual(
    signWindowsNativeResources.getWindowsNativeResourcePaths(appOutDir, OFF),
    signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES.map((relativePath) =>
      path.join(appOutDir, ...relativePath.split("/")),
    ),
  );
  assert.deepEqual(
    signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES.filter(mentionsPgmHelper),
    [],
  );

  // VC runtime: the two helper folders, nothing else.
  assert.deepEqual(vcRuntime.getWindowsVcRuntimeHelperDirs(OFF), [
    "native/display-helper",
    "native/meeting-helper",
  ]);
  assert.deepEqual(
    vcRuntime.getWindowsVcRuntimeHelperDirs(OFF),
    [...vcRuntime.WINDOWS_VC_RUNTIME_HELPER_DIRS],
  );
  assert.deepEqual(
    vcRuntime.getWindowsVcRuntimeResourceEntries(OFF).map((entry) => entry.to),
    ["native/display-helper", "native/meeting-helper"],
  );
  assert.deepEqual(
    vcRuntime.getWindowsVcRuntimePackagedPaths(OFF).filter(mentionsPgmHelper),
    [],
  );

  // Dependency gate: a package without native/pgm-helper passes, and only the
  // two helper folders are inspected.
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "broadify-pgm-contract-"));
  try {
    for (const dir of ["display-helper", "meeting-helper"]) {
      fs.mkdirSync(path.join(resourcesDir, "native", dir), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, "native", dir, `${dir}.exe`), "pe");
    }
    const inspected = [];
    const result = await withSwitch(undefined, () =>
      verifyNativeDependencies({
        resourcesDir,
        runDumpbin: (file) => {
          inspected.push(path.basename(file));
          return "";
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(inspected, ["display-helper.exe", "meeting-helper.exe"]);
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("with the switch the helper is packaged, signed, gets the VC runtime and is required - together", () => {
  const off = loadBuilderConfig(undefined);
  const on = loadBuilderConfig("1");

  // Packaging: the exe and the CRT set for its folder, nothing else moves.
  const exeEntry = { from: PGM_HELPER_SOURCE, to: PGM_HELPER_PACKAGED };
  const crtEntry = {
    from: vcRuntime.WINDOWS_VC_RUNTIME_STAGING_DIR,
    to: PGM_HELPER_DIR,
    filter: [...vcRuntime.WINDOWS_VC_RUNTIME_DLLS],
  };
  assert.deepEqual(on.win.filter(mentionsPgmHelper), [exeEntry, crtEntry]);
  assert.deepEqual(
    on.win.filter((entry) => !mentionsPgmHelper(entry)),
    off.win,
    "every other Windows resource stays where it was",
  );
  // The switch is a Windows build switch: the common and the macOS resources ignore it.
  assert.deepEqual(on.extraResources, off.extraResources);
  assert.deepEqual(on.mac, off.mac);
  assert.equal(on.afterSign, off.afterSign);
  assert.deepEqual(pgmHelper.getWindowsPgmHelperResourceEntries(ON), [exeEntry]);

  // Signing: appended to the fixed list. verify-windows-release-signatures.ps1
  // checks every packaged .exe, so a packaged helper has to be signed.
  const appOutDir = path.join(os.tmpdir(), "broadify-app-out");
  const signedOff = signWindowsNativeResources.getWindowsNativeResourcePaths(appOutDir, OFF);
  const signedOn = signWindowsNativeResources.getWindowsNativeResourcePaths(appOutDir, ON);
  assert.deepEqual(signedOn, [
    ...signedOff,
    path.join(appOutDir, ...PGM_HELPER_SIGNED.split("/")),
  ]);
  assert.deepEqual(pgmHelper.getWindowsPgmHelperSigningPaths(ON), [PGM_HELPER_SIGNED]);
  assert.match(
    read("scripts/verify-windows-release-signatures.ps1"),
    /Get-ChildItem -Path \$resolvedDistPath -Recurse -Include \*\.exe,\*\.msi -File/,
  );

  // VC runtime: pgm-helper.exe is an /MD build, the CRT has to sit next to it.
  // The DLLs keep Microsoft's signature and stay out of the signing list.
  assert.deepEqual(vcRuntime.getWindowsVcRuntimeHelperDirs(ON), [
    "native/display-helper",
    "native/meeting-helper",
    PGM_HELPER_DIR,
  ]);
  const packagedCrt = vcRuntime.getWindowsVcRuntimePackagedPaths(ON);
  for (const dll of vcRuntime.WINDOWS_VC_RUNTIME_DLLS) {
    assert.ok(packagedCrt.includes(`${PGM_HELPER_DIR}/${dll}`), dll);
    assert.ok(!signedOn.includes(path.join(appOutDir, "resources", ...PGM_HELPER_DIR.split("/"), dll)));
  }
  assert.deepEqual(
    vcRuntime.getWindowsVcRuntimePackagedPaths(ON).filter((file) => !mentionsPgmHelper(file)),
    vcRuntime.getWindowsVcRuntimePackagedPaths(OFF),
  );

  // Artifact check and smoke tests read the same entry.
  assert.deepEqual(pgmHelper.getWindowsPgmHelperSourcePaths(ON), [PGM_HELPER_SOURCE]);
  assert.deepEqual(pgmHelper.getWindowsPgmHelperPackagedPaths(ON), [PGM_HELPER_PACKAGED]);
  assert.deepEqual(pgmHelper.getWindowsPgmHelperVcRuntimeDirs(ON), [PGM_HELPER_DIR]);
});

test("the packaged path is where the build puts the helper and where the bridge looks for it", () => {
  // build.ps1 writes pgm-helper.exe next to itself.
  assert.match(
    read("apps/bridge/native/pgm-helper/build.ps1"),
    /\$outputExe = Join-Path \$rootDir "pgm-helper\.exe"/,
  );
  assert.equal(pgmHelper.WINDOWS_PGM_HELPER_SOURCE_PATH, PGM_HELPER_SOURCE);
  // A packaged bridge resolves resources/native/<dirName>/<binaryName>.exe. The
  // lookup itself is pinned by behaviour (helper-launch.test.ts, "finds the
  // packaged Windows helper ..."); here only the two names the helper's spec
  // feeds into it, which are the ones the package uses.
  const manager = stripCodeComments(read("apps/bridge/src/services/pgm/pgm-helper-manager.ts"));
  assert.match(manager, /\bdirName:\s*"pgm-helper"/);
  assert.match(manager, /\bbinaryName:\s*"pgm-helper"/);
  assert.equal(pgmHelper.WINDOWS_PGM_HELPER_PACKAGED_PATH, PGM_HELPER_PACKAGED);
  assert.equal(pgmHelper.WINDOWS_PGM_HELPER_DIR, PGM_HELPER_DIR);
});

test("the afterSign hook signs the helper exactly when the switch packaged it, and fails when it is missing", async () => {
  const run = async (value, { withHelper }) => {
    const appOutDir = fs.mkdtempSync(path.join(os.tmpdir(), "broadify-pgm-signing-"));
    const log = console.log;
    try {
      for (const relativePath of [
        ...signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES,
        ...(withHelper ? [PGM_HELPER_SIGNED] : []),
      ]) {
        const file = path.join(appOutDir, ...relativePath.split("/"));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "test artifact");
      }
      const signed = [];
      console.log = () => {};
      await withSwitch(value, () =>
        signWindowsNativeResources({
          appOutDir,
          electronPlatformName: "win32",
          packager: {
            platformSpecificBuildOptions: { azureSignOptions: {} },
            async sign(file) {
              signed.push(path.relative(appOutDir, file).split(path.sep).join("/"));
              return true;
            },
          },
        }),
      );
      return signed;
    } finally {
      console.log = log;
      fs.rmSync(appOutDir, { recursive: true, force: true });
    }
  };

  const fixed = [...signWindowsNativeResources.WINDOWS_NATIVE_RESOURCES];
  assert.deepEqual(await run(undefined, { withHelper: false }), fixed);
  // Without the switch a stray file is not signed either: the list decides, not the disk.
  assert.deepEqual(await run(undefined, { withHelper: true }), fixed);
  assert.deepEqual(await run("1", { withHelper: true }), [...fixed, PGM_HELPER_SIGNED]);
  await assert.rejects(run("1", { withHelper: false }), /pgm-helper\.exe/);
});

test("with the switch the dependency gate inspects the helper folder and fails closed without it", async () => {
  const resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "broadify-pgm-contract-"));
  try {
    for (const dir of ["display-helper", "meeting-helper"]) {
      fs.mkdirSync(path.join(resourcesDir, "native", dir), { recursive: true });
      fs.writeFileSync(path.join(resourcesDir, "native", dir, `${dir}.exe`), "pe");
    }
    await assert.rejects(
      withSwitch("1", () => verifyNativeDependencies({ resourcesDir, runDumpbin: () => "" })),
      /native\/pgm-helper/,
    );

    fs.mkdirSync(path.join(resourcesDir, "native", "pgm-helper"), { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, "native", "pgm-helper", "pgm-helper.exe"), "pe");
    const inspected = [];
    const result = await withSwitch("1", () =>
      verifyNativeDependencies({
        resourcesDir,
        runDumpbin: (file) => {
          inspected.push(path.basename(file));
          return "";
        },
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(inspected, ["display-helper.exe", "meeting-helper.exe", "pgm-helper.exe"]);
  } finally {
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  }
});

test("the list CLI prints nothing without the switch and the helper paths with it", () => {
  for (const args of [[], ["--packaged"], ["--source"]]) {
    for (const value of [undefined, "0", "true"]) {
      const off = runListCli(args, value);
      assert.equal(off.status, 0, off.stderr);
      // Not even a newline: PowerShell would read it as one (empty) entry.
      assert.equal(off.stdout, "", `${args.join(" ")} with ${JSON.stringify(value)}`);
    }
  }
  const packaged = runListCli([], "1");
  assert.equal(packaged.status, 0, packaged.stderr);
  assert.equal(packaged.stdout, `${PGM_HELPER_PACKAGED}\n`);
  assert.equal(runListCli(["--packaged"], "1").stdout, `${PGM_HELPER_PACKAGED}\n`);
  const source = runListCli(["--source"], "1");
  assert.equal(source.status, 0, source.stderr);
  assert.equal(source.stdout, `${PGM_HELPER_SOURCE}\n`);

  assert.notEqual(runListCli(["--bogus"], "1").status, 0);
  assert.notEqual(runListCli(["--source", "extra"], "1").status, 0);
});

test("the artifact check requires the helper through that list, in the Windows branch only", () => {
  const script = read("scripts/verify-release-artifacts.sh");
  const branches = script.split(
    'elif [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then\n',
  );
  assert.equal(branches.length, 3, "one Windows branch for the lists, one for the checks");
  const windowsLists = branches[1].slice(0, branches[1].indexOf("\nelse\n"));
  const windowsChecks = branches[2].slice(0, branches[2].indexOf("\nelse\n"));

  // Required and executable, list from the Node single source of truth.
  assert.match(
    windowsLists,
    /\n  pgm_helper_files="\$\(node "\$ROOT_DIR\/scripts\/list-windows-pgm-helper-paths\.cjs" --source\)"\n  while IFS= read -r pgm_helper_file; do\n    if \[\[ -n "\$pgm_helper_file" \]\]; then\n      REQUIRED_FILES\+=\("\$pgm_helper_file"\)\n      EXECUTABLE_FILES\+=\("\$pgm_helper_file"\)\n    fi\n  done <<< "\$pgm_helper_files"$/,
  );
  assert.match(
    windowsChecks,
    /\n  while IFS= read -r pgm_helper_file; do\n    if \[\[ -n "\$pgm_helper_file" \]\]; then\n      check_architecture "\$pgm_helper_file"\n    fi\n  done <<< "\$pgm_helper_files"\n/,
  );
  // Nowhere else, and never as a literal path or with a test of the switch of its own.
  assert.equal((script.match(/list-windows-pgm-helper-paths\.cjs/g) || []).length, 1);
  assert.ok(!script.includes("pgm-helper.exe"));
  const code = script.split("\n").filter((line) => !/^\s*#/.test(line));
  assert.deepEqual(code.filter((line) => SWITCH_PATTERN.test(line)), []);
  for (const other of [
    branches[0],
    branches[1].slice(branches[1].indexOf("\nelse\n")),
    branches[2].slice(branches[2].indexOf("\nelse\n")),
  ]) {
    assert.ok(!other.includes("pgm_helper_file"), "macOS and Linux branches stay as they were");
  }
});

// The script is only executed from POSIX hosts (see the skip reason below), so
// a Windows host does not even look for a bash here.
const canRunArtifactCheck =
  process.platform !== "win32" &&
  spawnSync("bash", ["-c", "true"], { stdio: "ignore" }).status === 0;

/**
 * Runs scripts/verify-release-artifacts.sh the way dist:win does, for a
 * Windows host: a copy of the script and of what it calls in a sandbox,
 * `uname` and `file` answered as Git Bash on the release runner would, and
 * every artifact the script names present as a placeholder file.
 */
function runWindowsArtifactCheck(value, { withHelper }) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "broadify-pgm-artifacts-"));
  try {
    for (const file of [
      "scripts/verify-release-artifacts.sh",
      "scripts/list-windows-vc-runtime-paths.cjs",
      "scripts/list-windows-pgm-helper-paths.cjs",
      "scripts/lib/windows-vc-runtime.cjs",
      "scripts/lib/windows-pgm-helper.cjs",
    ]) {
      fs.mkdirSync(path.dirname(path.join(sandbox, file)), { recursive: true });
      fs.copyFileSync(path.join(root, file), path.join(sandbox, file));
    }
    const shims = path.join(sandbox, ".shims");
    fs.mkdirSync(shims);
    fs.writeFileSync(
      path.join(shims, "uname"),
      '#!/bin/sh\nif [ "$1" = "-m" ]; then echo x86_64; else echo MINGW64_NT-10.0-20348; fi\n',
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(shims, "file"),
      '#!/bin/sh\necho "$1: PE32+ executable (console) x86-64, for MS Windows"\n',
      { mode: 0o755 },
    );

    // Every artifact the script names for a Windows build: the common list,
    // the literal entries of the Windows branch, the staged CRT. The helper
    // comes on top when the caller wants it there.
    const script = read("scripts/verify-release-artifacts.sh");
    const common = script.match(/\nREQUIRED_FILES=\(\n([\s\S]*?)\n\)\n/);
    assert.ok(common, "common REQUIRED_FILES list");
    const windowsBranch = script
      .split('elif [[ "$UNAME_S" == MINGW* || "$UNAME_S" == MSYS* || "$UNAME_S" == CYGWIN* ]]; then\n')[1]
      .split("\nelse\n")[0];
    const artifacts = new Set([
      ...[...common[1].matchAll(/"([^"$]+)"/g)].map((match) => match[1]),
      ...[...windowsBranch.matchAll(/REQUIRED_FILES\+=\("([^"$]+)"\)/g)].map((match) => match[1]),
      ...vcRuntime.getWindowsVcRuntimeStagedPaths(),
    ]);
    if (withHelper) {
      artifacts.add(PGM_HELPER_SOURCE);
    }
    for (const artifact of artifacts) {
      const file = path.join(sandbox, ...artifact.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "placeholder", { mode: 0o755 });
    }
    // The MODNet hash check compares the model with its manifest.
    const modelsDir = path.join(sandbox, "apps", "bridge", "native", "meeting-helper", "models");
    const sha256 = crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(modelsDir, "modnet.onnx")))
      .digest("hex");
    fs.writeFileSync(
      path.join(modelsDir, "manifest.json"),
      JSON.stringify({ models: [{ name: "modnet", sha256 }] }),
    );

    const result = spawnSync(
      "bash",
      [path.join(sandbox, "scripts", "verify-release-artifacts.sh"), "--arch", "x64"],
      {
        cwd: sandbox,
        encoding: "utf8",
        env: { ...childEnv(value), PATH: `${shims}${path.delimiter}${process.env.PATH}` },
      },
    );
    const lines = result.stdout.split("\n");
    return {
      status: result.status,
      stderr: result.stderr,
      required: lines
        .map((line) => /^\[Verify\] (.+) -> mode=/.exec(line))
        .filter(Boolean)
        .map((match) => match[1]),
      architectureChecked: lines.filter((line) => /: PE32\+ executable/.test(line)).length,
      completed: lines.includes("[Verify] Release artifact verification completed successfully."),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

test(
  "the artifact check, run as on the Windows release runner, requires the helper exactly with the switch",
  {
    // The Windows branch is selected through a stand-in `uname`. On a Windows
    // host the real one answers anyway, and dist:win runs the script itself.
    skip:
      !canRunArtifactCheck &&
      "needs bash on a POSIX host; on Windows dist:win runs the script itself",
  },
  () => {
    const off = runWindowsArtifactCheck(undefined, { withHelper: false });
    assert.equal(off.status, 0, off.stderr);
    assert.ok(off.completed);
    assert.ok(off.required.includes("apps/bridge/native/meeting-helper/meeting-helper.exe"), "the Windows branch ran");
    assert.deepEqual(off.required.filter(mentionsPgmHelper), []);

    // A helper lying around does not get required or checked without the switch.
    const stray = runWindowsArtifactCheck(undefined, { withHelper: true });
    assert.equal(stray.status, 0, stray.stderr);
    assert.deepEqual(stray.required, off.required);
    assert.equal(stray.architectureChecked, off.architectureChecked);

    // With the switch: the same list plus the exe, which is also checked for x64.
    const on = runWindowsArtifactCheck("1", { withHelper: true });
    assert.equal(on.status, 0, on.stderr);
    assert.ok(on.completed);
    assert.deepEqual(on.required, [...off.required, PGM_HELPER_SOURCE]);
    assert.equal(on.architectureChecked, off.architectureChecked + 1);

    // ... and a build that skipped the helper fails here, before packaging.
    const missing = runWindowsArtifactCheck("1", { withHelper: false });
    assert.notEqual(missing.status, 0);
    assert.ok(!missing.completed);
    assert.match(missing.stderr, /\[Verify\] Missing artifact: apps\/bridge\/native\/pgm-helper\/pgm-helper\.exe/);
  },
);

test("dist:win builds the helper through the gated wrapper, before the artifact check", () => {
  const packageJson = JSON.parse(read("package.json"));
  const distWin = packageJson.scripts["dist:win"];
  const steps = distWin.split(" && ");
  assert.equal(steps.filter((step) => step === "npm run build:pgm-helper").length, 1);
  // After the meeting helper (as on macOS), before `npm run build` (the test
  // gate), the artifact check that requires the exe and the packaging.
  const order = [
    "npm run test:meeting-helper-native",
    "npm run build:pgm-helper",
    "npm run build",
    "bash scripts/verify-release-artifacts.sh --arch x64",
  ].map((step) => steps.indexOf(step));
  assert.ok(!order.includes(-1), `dist:win lost a step: ${order.join(", ")}`);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "steps of dist:win are out of order");
  const packaging = steps.findIndex((step) =>
    step.includes("electron-builder/cli.js --config electron-builder.config.cjs --win"),
  );
  assert.ok(packaging > order.at(-1), "electron-builder runs after the artifact check");
  assert.equal(packageJson.scripts["build:pgm-helper"], "bash scripts/build-pgm-helper.sh");

  // No npm script turns the switch on: dist:win only reaches the wrapper,
  // and the wrapper builds on Windows only with BROADIFY_PGM_WINDOWS=1.
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.ok(!SWITCH_PATTERN.test(command), `npm script ${name} must not set the build switch`);
    assert.ok(!command.includes("pgm-helper/build.ps1"), `npm script ${name} must go through the wrapper`);
  }
  const wrapper = read("scripts/build-pgm-helper.sh");
  assert.match(
    wrapper,
    /\nif \[\[ "\$UNAME_S" == MINGW\* \|\| "\$UNAME_S" == MSYS\* \|\| "\$UNAME_S" == CYGWIN\* \]\] && \[\[ "\$\{BROADIFY_PGM_WINDOWS:-\}" == "1" \]\]; then\n/,
  );
  assert.ok(
    wrapper.endsWith('echo "Skipping PGM helper build on $UNAME_S (phase 1 ships macOS only)."\nexit 0\n'),
    "without the switch the Windows build ends in the skip it always printed",
  );
});

test("the native build keeps the Windows program stream off without the switch", () => {
  const liveStream = read("apps/bridge/native/live-stream/CMakeLists.txt");
  const option = liveStream.match(/if\(NOT DEFINED LIVE_STREAM_WITH_WEBRTC\)\n([\s\S]*?)\nendif\(\)\n/);
  assert.ok(option, "LIVE_STREAM_WITH_WEBRTC default block must exist");
  assert.equal(
    option[1],
    [
      "  if(APPLE)",
      "    set(LIVE_STREAM_WITH_WEBRTC ON)",
      '  elseif(WIN32 AND "$ENV{BROADIFY_PGM_WINDOWS}" STREQUAL "1")',
      "    set(LIVE_STREAM_WITH_WEBRTC ON)",
      "  else()",
      "    set(LIVE_STREAM_WITH_WEBRTC OFF)",
      "  endif()",
    ].join("\n"),
  );
  // pgm-helper.exe exists only where that part was configured.
  assert.match(
    read("apps/bridge/native/pgm-helper/CMakeLists.txt"),
    /\nif\(PGM_HELPER_BUILD_BINARY AND WIN32 AND TARGET live_stream\)\n/,
  );
});

test("a packaged helper stays off until the bridge's own run-time switch BRIDGE_PGM_WINDOWS", () => {
  // What the gate does is pinned by behaviour (pgm-env.test.ts,
  // pgm-command-handler.test.ts). Here only what packaging relies on: the
  // bridge decides by its own switch, and the command handler asks that gate.
  const env = stripCodeComments(read("apps/bridge/src/services/pgm/pgm-env.ts"));
  assert.match(env, /"BRIDGE_PGM_WINDOWS"/);
  assert.match(env, /export function isPgmPlatformSupported\b/);
  const handler = stripCodeComments(read("apps/bridge/src/services/pgm/pgm-command-handler.ts"));
  assert.match(handler, /\bisPgmPlatformSupported\(/);

  // The bridge never reads the build switch: packaging a helper enables nothing.
  for (const file of [
    "apps/bridge/src/services/pgm/pgm-env.ts",
    "apps/bridge/src/services/pgm/pgm-command-handler.ts",
    "apps/bridge/src/services/pgm/pgm-helper-manager.ts",
    "apps/bridge/src/services/helpers/helper-launch.ts",
  ]) {
    assert.doesNotMatch(stripCodeComments(read(file)), SWITCH_PATTERN, `${file} must not read the build switch`);
  }
});

test("the installer smoke tests check the helper only in a build that packaged it", () => {
  const helperSmoke = read("scripts/test-windows-pgm-helper.ps1");
  // The list decides; an empty list returns before the package is touched.
  const list = helperSmoke.indexOf('Join-Path $PSScriptRoot "list-windows-pgm-helper-paths.cjs"');
  const earlyReturn = helperSmoke.indexOf("if ($pgmHelperPaths.Count -eq 0) {");
  const resolve = helperSmoke.indexOf("Resolve-Path -LiteralPath $ResourcesDir");
  const probe = helperSmoke.indexOf("& $helperPath --probe");
  assert.ok(list > 0 && earlyReturn > list && resolve > earlyReturn && probe > resolve);
  assert.match(
    helperSmoke.slice(earlyReturn, resolve),
    /^if \(\$pgmHelperPaths\.Count -eq 0\) \{\n  # [^\n]*\n  return\n\}\n/,
  );
  assert.match(helperSmoke, /throw "Packaged PGM helper is missing: \$helperPath /);
  assert.match(helperSmoke, /\$payload\.encoder -ne "mediafoundation"/);
  assert.doesNotMatch(helperSmoke, /\$env:BROADIFY_PGM_WINDOWS/i, "the switch is read in one place, the Node module");

  for (const script of ["scripts/smoke-test-windows-nsis.ps1", "scripts/smoke-test-windows-msi.ps1"]) {
    const text = read(script);
    assert.equal((text.match(/test-windows-pgm-helper\.ps1/g) || []).length, 1, script);
    assert.match(text, /-ResourcesDir \(Join-Path \$installDir "resources"\)\n/, script);
    assert.doesNotMatch(text, /\$env:BROADIFY_PGM_WINDOWS/i, script);
    // The CRT next to the helper is asserted through the VC runtime list, which follows the same switch.
    assert.match(text, /list-windows-vc-runtime-paths\.cjs/, script);
  }
});

test("the release workflows install the helper's dependencies only behind the switch and never set it", () => {
  const release = read(".github/workflows/release.yml");
  const testRelease = read(".github/workflows/test-release.yml");
  const stepName = "Install static OpenSSL (Windows, for pgm-helper, opt-in build only)";

  for (const [workflow, source] of [["release.yml", release], ["test-release.yml", testRelease]]) {
    const step = findStep(source, stepName);
    assert.match(
      step,
      /\n        if: matrix\.os == 'windows-2022' && env\.BROADIFY_PGM_WINDOWS == '1'\n        shell: pwsh\n/,
      workflow,
    );
    assert.match(runBlock(step), /\n& \.\\scripts\\prepare-windows-pgm-deps\.ps1 -VcpkgRoot \$vcpkgRoot$/, workflow);
    assert.equal((source.match(/prepare-windows-pgm-deps/g) || []).length, 1, workflow);

    // After the MSVC environment and vcpkg are there, before the build that needs the result.
    const names = workflowSteps(source).map((entry) => entry.split("\n")[0].replace("      - name: ", ""));
    const position = names.indexOf(stepName);
    assert.ok(position > names.indexOf("Setup MSVC Developer Command Prompt (Windows)"), workflow);
    assert.ok(position > names.indexOf("Install SDL2 (Windows, for display-helper)"), workflow);
    assert.ok(position < names.indexOf("Build Electron App"), workflow);

    // The workflows build the helper only through dist:win.
    assert.ok(!source.includes("build-pgm-helper"), workflow);
    assert.ok(!source.includes("pgm-helper/build.ps1") && !source.includes("pgm-helper\\build.ps1"), workflow);
  }
  // Same step in both workflows.
  assert.equal(findStep(release, stepName).trimEnd(), findStep(testRelease, stepName).trimEnd());

  // Neither workflow sets the switch (rule: switchRuleViolations). This is the
  // one place that reads the environment the tests run in: it decides whether
  // test-release.yml may carry the switch.
  assert.deepEqual(switchRuleViolations({ workflow: "release.yml", source: release, env: process.env }), []);
  assert.deepEqual(switchRuleViolations({ workflow: "test-release.yml", source: testRelease, env: process.env }), []);

  // No other workflow sets it either, except the native CI that exists to test it.
  const workflowDir = path.join(root, ".github", "workflows");
  for (const file of fs.readdirSync(workflowDir)) {
    if (["release.yml", "test-release.yml", "pgm-windows-native.yml"].includes(file)) {
      continue;
    }
    assert.doesNotMatch(read(`.github/workflows/${file}`), SWITCH_PATTERN, file);
  }
});

test("the switch may sit in test-release.yml only for an opt-in build, and never in release.yml", () => {
  // The rule itself, on variants of the two workflows. The variants start
  // from the files without any line that sets the switch, so this test also
  // holds on the opt-in branch, where test-release.yml carries one.
  const withoutSwitchLines = (source) =>
    source
      .split("\n")
      .filter((line) => switchMentionsOutsideGuard(line).length === 0)
      .join("\n");
  const release = withoutSwitchLines(read(".github/workflows/release.yml"));
  const testRelease = withoutSwitchLines(read(".github/workflows/test-release.yml"));
  const jobEnvAnchor = '      npm_config_msvs_version: "2022"\n';
  const stepAnchor = "      - name: Build Electron App\n";
  const insertAfter = (source, anchor, text) => {
    assert.equal(source.split(anchor).length, 2, `anchor ${JSON.stringify(anchor)} must exist once`);
    return source.replace(anchor, anchor + text);
  };
  const violations = (workflow, source, env) => switchRuleViolations({ workflow, source, env });
  const withoutSwitch = {};
  const local = { [SWITCH]: "1" };
  const ci = (ref) => ({ [SWITCH]: "1", GITHUB_ACTIONS: "true", GITHUB_REF_NAME: ref });

  // Without such a line: fine in every environment.
  for (const env of [withoutSwitch, local, ci("dev"), ci("test-release/pgm-windows")]) {
    assert.deepEqual(violations("release.yml", release, env), []);
    assert.deepEqual(violations("test-release.yml", testRelease, env), []);
  }

  // The documented opt-in line: one line in the job environment of test-release.yml.
  const optIn = insertAfter(testRelease, jobEnvAnchor, '      BROADIFY_PGM_WINDOWS: "1"\n');
  assert.deepEqual(violations("test-release.yml", optIn, local), []);
  assert.deepEqual(violations("test-release.yml", optIn, ci("test-release/pgm-windows")), []);
  assert.deepEqual(violations("test-release.yml", optIn, ci("test-release/pgm-windows-2")), []);
  // Red in every run without the switch: local runs, the CI rehearsal, every real release build.
  assert.equal(violations("test-release.yml", optIn, withoutSwitch).length, 1);
  assert.equal(violations("test-release.yml", optIn, { GITHUB_ACTIONS: "true", GITHUB_REF_NAME: "dev" }).length, 1);
  // In CI the line builds an installer only from the opt-in branch.
  for (const ref of ["dev", "main", "test-release", "test-release/other", "feature/test-release/pgm-windows", undefined]) {
    assert.match(
      violations("test-release.yml", optIn, ci(ref)).join("\n"),
      /an opt-in build runs from a branch test-release\/pgm-windows only/,
      `ref ${ref}`,
    );
  }

  // For the whole job only, and under its own name only.
  const perStep = insertAfter(testRelease, stepAnchor, '        env:\n          BROADIFY_PGM_WINDOWS: "1"\n');
  assert.match(violations("test-release.yml", perStep, ci("test-release/pgm-windows")).join("\n"), /for the whole job/);
  const viaGithubEnv = insertAfter(
    testRelease,
    stepAnchor,
    '        run: echo "BROADIFY_PGM_WINDOWS=1" >> "$GITHUB_ENV"\n',
  );
  assert.match(violations("test-release.yml", viaGithubEnv, ci("test-release/pgm-windows")).join("\n"), /for the whole job/);
  const otherSpelling = insertAfter(testRelease, jobEnvAnchor, '      broadify_pgm_windows: "1"\n');
  assert.equal(violations("test-release.yml", otherSpelling, withoutSwitch).length, 1, "any spelling is a mention");
  assert.match(violations("test-release.yml", otherSpelling, ci("test-release/pgm-windows")).join("\n"), /for the whole job/);

  // release.yml: never, whatever the environment.
  for (const text of ['      BROADIFY_PGM_WINDOWS: "1"\n', '      Broadify_Pgm_Windows: "1"\n']) {
    const flagged = insertAfter(release, jobEnvAnchor, text);
    for (const env of [withoutSwitch, local, ci("test-release/pgm-windows"), ci("v0.27.3-rc.24")]) {
      assert.match(violations("release.yml", flagged, env).join("\n"), /release\.yml must not set/);
    }
  }
  // A comment may name the switch; the guard of the one step is the only code that does.
  const commented = insertAfter(release, jobEnvAnchor, "      # BROADIFY_PGM_WINDOWS stays unset here\n");
  assert.deepEqual(violations("release.yml", commented, withoutSwitch), []);
});

test("the Windows CI rehearses the release gate with the release's own install steps", () => {
  const release = read(".github/workflows/release.yml");
  const workflow = read(".github/workflows/pgm-windows-native.yml");
  const start = workflow.indexOf("\n  bridge-tests:\n");
  const end = workflow.indexOf("\n  encoder:\n");
  assert.ok(start > workflow.indexOf("\n  core:\n") && end > start, "bridge-tests sits between core and encoder");
  const job = workflow.slice(start, end);

  assert.match(job, /\n    runs-on: windows-2022\n/);
  assert.match(release, /\n          - os: windows-2022\n            artifact: win-x64\n            dist_script: dist:win\n/);
  assert.ok(!job.includes("continue-on-error"), "a red gate must fail the run");
  assert.ok(!job.includes("secrets."), "the rehearsal needs no secret");

  // Node version and dependency cache as in the release.
  const setupNode = (source) => findStep(source, "Setup Node.js").split("\n").slice(1).join("\n").trimEnd();
  assert.equal(setupNode(job), setupNode(release));
  // Same install and pre-test build steps, run in the same shell.
  assert.match(workflow, /\ndefaults:\n  run:\n    shell: pwsh\n/);
  for (const name of [
    "Install root deps (Windows, retry)",
    "Install Bridge dependencies (Windows, retry)",
    "Build Bridge (apps/bridge)",
    "Transpile Electron",
  ]) {
    const mine = findStep(job, name);
    const theirs = findStep(release, name);
    const command = (step) =>
      /\n        run: \|\n/.test(step) ? runBlock(step) : step.match(/\n        run: (.+)\n?/)[1];
    assert.equal(command(mine), command(theirs), name);
  }
  // In that order, and then the gate: what `npm run build` runs first.
  const names = workflowSteps(job).map((entry) => entry.split("\n")[0].replace("      - name: ", ""));
  assert.deepEqual(names.slice(0, 7), [
    "Checkout",
    "Setup Node.js",
    "Install root deps (Windows, retry)",
    "Install Bridge dependencies (Windows, retry)",
    "Build Bridge (apps/bridge)",
    "Transpile Electron",
    "Release gate (npm run test)",
  ]);
  assert.match(findStep(job, "Release gate (npm run test)"), /\n        run: npm run test\n/);
  const packageJson = JSON.parse(read("package.json"));
  assert.ok(packageJson.scripts.build.startsWith("npm run test && "));
  assert.equal(packageJson.scripts.test, "npm run test:jest && npm run test:release-contracts");
  assert.ok(packageJson.scripts["dist:win"].split(" && ").includes("npm run build"));

  // The job runs for everything the tests read.
  const paths = workflow.slice(workflow.indexOf("\n    paths:\n"), workflow.indexOf("\npermissions:\n"));
  for (const entry of [
    "src/**",
    "apps/bridge/src/**",
    "packages/protocol/**",
    "scripts/**",
    "package.json",
    "package-lock.json",
    "electron-builder.config.cjs",
    "jest.config.cjs",
    ".github/workflows/release.yml",
    ".github/workflows/test-release.yml",
  ]) {
    assert.ok(paths.includes(`\n      - ${entry}\n`), `${entry} must trigger the workflow`);
  }
});

test("the release contract suite runs these checks", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["test:release-contracts"],
    /scripts\/pgm-helper-windows-release-contract\.test\.cjs/,
  );
});
