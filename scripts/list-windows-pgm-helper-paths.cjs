#!/usr/bin/env node
/**
 * Prints the Windows PGM helper paths from scripts/lib/windows-pgm-helper.cjs,
 * one per line, so the bash and PowerShell release scripts share the Node
 * single source of truth (same pattern as list-windows-vc-runtime-paths.cjs).
 *
 * Without the build switch BROADIFY_PGM_WINDOWS=1 it prints nothing and exits
 * 0: the callers then have nothing to require, assert or probe.
 *
 *   (no flag) / --packaged  paths relative to the packaged resources/ folder
 *   --source                repo-relative build outputs required before packaging
 */
const {
  getWindowsPgmHelperPackagedPaths,
  getWindowsPgmHelperSourcePaths,
} = require("./lib/windows-pgm-helper.cjs");

const MODES = {
  "--packaged": getWindowsPgmHelperPackagedPaths,
  "--source": getWindowsPgmHelperSourcePaths,
};

function main(argv, env = process.env) {
  const [mode = "--packaged", ...rest] = argv;
  if (rest.length > 0 || !Object.hasOwn(MODES, mode)) {
    process.stderr.write(
      `Usage: node scripts/list-windows-pgm-helper-paths.cjs [${Object.keys(MODES).join(" | ")}]\n`,
    );
    return 1;
  }
  const paths = MODES[mode](env);
  // No trailing newline for an empty list: a blank line would read as one
  // (empty) entry in PowerShell.
  if (paths.length > 0) {
    process.stdout.write(`${paths.join("\n")}\n`);
  }
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
