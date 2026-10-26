#!/usr/bin/env node
/**
 * Prints the MSVC runtime file list from scripts/lib/windows-vc-runtime.cjs,
 * one entry per line, so the PowerShell and bash release scripts share the
 * Node single source of truth (same pattern as
 * resolve-windows-install-directory-name.cjs for smoke-test-windows-nsis.ps1).
 *
 *   (no flag) / --packaged  paths relative to the packaged resources/ folder
 *   --staged                repo-relative paths in build/windows-vc-runtime/
 *   --dlls                  bare DLL file names
 */
const {
  WINDOWS_VC_RUNTIME_DLLS,
  getWindowsVcRuntimePackagedPaths,
  getWindowsVcRuntimeStagedPaths,
} = require("./lib/windows-vc-runtime.cjs");

const MODES = {
  "--packaged": getWindowsVcRuntimePackagedPaths,
  "--staged": getWindowsVcRuntimeStagedPaths,
  "--dlls": () => [...WINDOWS_VC_RUNTIME_DLLS],
};

function main(argv) {
  const [mode = "--packaged", ...rest] = argv;
  if (rest.length > 0 || !Object.hasOwn(MODES, mode)) {
    process.stderr.write(
      `Usage: node scripts/list-windows-vc-runtime-paths.cjs [${Object.keys(MODES).join(" | ")}]\n`,
    );
    return 1;
  }
  process.stdout.write(`${MODES[mode]().join("\n")}\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
