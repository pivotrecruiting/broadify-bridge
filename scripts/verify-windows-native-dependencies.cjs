#!/usr/bin/env node
/**
 * Release gate: every packaged Windows helper exe/dll must only import inbox
 * Windows DLLs or files packaged in the same folder.
 *
 * Runs `dumpbin /DEPENDENTS` (on PATH after ilammy/msvc-dev-cmd or in a VS
 * developer prompt) on every .exe/.dll under the helper folders of the
 * unpacked app and exits 1 listing `file -> missing import`. This catches a
 * missing CRT DLL even on a runner that has the VC++ redistributable
 * installed, where the helper smoke tests would still pass.
 *
 *   node scripts/verify-windows-native-dependencies.cjs \
 *     [--resources dist/win-unpacked/resources] [--dumpbin <path>]
 */
const { spawnSync } = require("node:child_process");
const { readdir, stat } = require("node:fs/promises");
const path = require("node:path");

const {
  evaluateDependencies,
  parseDumpbinDependents,
} = require("./lib/windows-native-dependency-policy.cjs");
const {
  WINDOWS_VC_RUNTIME_HELPER_DIRS,
} = require("./lib/windows-vc-runtime.cjs");

const PE_EXTENSIONS = new Set([".exe", ".dll"]);

function createDumpbinRunner(dumpbin) {
  return (file) => {
    const result = spawnSync(dumpbin, ["/NOLOGO", "/DEPENDENTS", file], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error) {
      throw new Error(
        `Unable to run ${dumpbin} (${result.error.code ?? result.error.message}); ` +
          "run from a Visual Studio developer prompt or after ilammy/msvc-dev-cmd.",
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `${dumpbin} /DEPENDENTS failed for ${file} with exit code ${result.status}: ${result.stderr || result.stdout}`,
      );
    }
    return result.stdout;
  };
}

async function listPeFilesByDirectory(directory) {
  const groups = [];
  const entries = (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const siblingFiles = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  const peFiles = siblingFiles.filter((name) =>
    PE_EXTENSIONS.has(path.extname(name).toLowerCase()),
  );
  if (peFiles.length > 0) {
    groups.push({ directory, siblingFiles, peFiles });
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      groups.push(...(await listPeFilesByDirectory(path.join(directory, entry.name))));
    }
  }
  return groups;
}

/**
 * @param {{
 *   resourcesDir: string,
 *   helperDirs?: readonly string[],
 *   runDumpbin?: (file: string) => string | Promise<string>,
 * }} options
 * @returns {Promise<{ ok: boolean, problems: Array<{ file: string, missing: string }>, inspected: number }>}
 */
async function verifyNativeDependencies({
  resourcesDir,
  helperDirs = WINDOWS_VC_RUNTIME_HELPER_DIRS,
  runDumpbin = createDumpbinRunner(process.env.DUMPBIN || "dumpbin"),
}) {
  const problems = [];
  let inspected = 0;

  for (const helperDir of helperDirs) {
    const absoluteHelperDir = path.join(resourcesDir, ...helperDir.split("/"));
    const stats = await stat(absoluteHelperDir).catch(() => null);
    if (!stats?.isDirectory()) {
      throw new Error(
        `Packaged helper directory not found: ${helperDir} (looked in ${absoluteHelperDir})`,
      );
    }

    for (const group of await listPeFilesByDirectory(absoluteHelperDir)) {
      for (const peFile of group.peFiles) {
        const absoluteFile = path.join(group.directory, peFile);
        const relativeFile = path
          .relative(resourcesDir, absoluteFile)
          .split(path.sep)
          .join("/");
        const imports = parseDumpbinDependents(await runDumpbin(absoluteFile));
        inspected += 1;
        const verdict = evaluateDependencies({
          imports,
          siblingFiles: group.siblingFiles,
        });
        for (const missing of verdict.missing) {
          problems.push({ file: relativeFile, missing });
        }
      }
    }
  }

  return { ok: problems.length === 0, problems, inspected };
}

function parseArgs(argv) {
  const options = {
    resourcesDir: path.join("dist", "win-unpacked", "resources"),
    dumpbin: process.env.DUMPBIN || "dumpbin",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === "--resources" && typeof value === "string") {
      options.resourcesDir = value;
      index += 1;
    } else if (arg === "--dumpbin" && typeof value === "string") {
      options.dumpbin = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  const resourcesDir = path.resolve(options.resourcesDir);
  const result = await verifyNativeDependencies({
    resourcesDir,
    runDumpbin: createDumpbinRunner(options.dumpbin),
  });

  if (!result.ok) {
    console.error(
      `[Deps] ${result.problems.length} unresolved import(s) in ${resourcesDir}:`,
    );
    for (const problem of result.problems) {
      console.error(`[Deps]   ${problem.file} -> ${problem.missing}`);
    }
    console.error(
      "[Deps] Each import must be an inbox Windows DLL (scripts/lib/windows-native-dependency-policy.cjs) " +
        "or packaged next to the importing file (electron-builder.config.cjs extraResources).",
    );
    return 1;
  }

  console.log(
    `[Deps] Verified ${result.inspected} packaged helper PE file(s) under ${resourcesDir}: ` +
      "all imports resolve to Windows or packaged siblings.",
  );
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[Deps] ${error.message}`);
      process.exitCode = 1;
    },
  );
}

module.exports = { verifyNativeDependencies, createDumpbinRunner };
