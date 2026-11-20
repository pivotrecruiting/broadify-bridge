/**
 * Windows PGM helper (pgm-helper.exe, live program preview; ADR-0009) in the
 * release packaging.
 *
 * The helper is built and packaged only behind the build switch
 * BROADIFY_PGM_WINDOWS=1, which is off by default. Without the switch every
 * list below is empty, so a Windows release packages, signs and verifies
 * exactly what it did before the helper existed. With it, one switch moves
 * all of them together: a helper that is packaged is also signed, gets the
 * VC runtime next to it and is required by the artifact check.
 *
 * Pure module: no file-system access, no side effects; the environment is an
 * argument (default: process.env). It is the single source of truth for
 * electron-builder.config.cjs (packaging), scripts/sign-windows-native-resources.cjs
 * (signing), scripts/lib/windows-vc-runtime.cjs (CRT folder) and, via
 * scripts/list-windows-pgm-helper-paths.cjs, for scripts/verify-release-artifacts.sh
 * and the Windows smoke tests.
 */

/**
 * Build switch. Enabled means exactly "1": the same test as
 * scripts/build-pgm-helper.sh and apps/bridge/native/live-stream/CMakeLists.txt,
 * so the lists never ask for a helper the build skipped.
 */
const WINDOWS_PGM_BUILD_SWITCH = "BROADIFY_PGM_WINDOWS";

/** Repo-relative build output of apps/bridge/native/pgm-helper/build.ps1. */
const WINDOWS_PGM_HELPER_SOURCE_PATH =
  "apps/bridge/native/pgm-helper/pgm-helper.exe";

/**
 * Helper folder relative to the packaged `resources/` directory. The bridge
 * resolves the helper there (services/helpers/helper-launch.ts:
 * resources/native/<dirName>/<binaryName>.exe).
 */
const WINDOWS_PGM_HELPER_DIR = "native/pgm-helper";

/** Packaged executable relative to `resources/` (forward slashes). */
const WINDOWS_PGM_HELPER_PACKAGED_PATH = `${WINDOWS_PGM_HELPER_DIR}/pgm-helper.exe`;

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function isWindowsPgmHelperEnabled(env = process.env) {
  return env[WINDOWS_PGM_BUILD_SWITCH] === "1";
}

/**
 * electron-builder `extraResources` entries for the Windows target.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {Array<{ from: string, to: string }>}
 */
function getWindowsPgmHelperResourceEntries(env = process.env) {
  if (!isWindowsPgmHelperEnabled(env)) {
    return [];
  }
  return [
    {
      from: WINDOWS_PGM_HELPER_SOURCE_PATH,
      to: WINDOWS_PGM_HELPER_PACKAGED_PATH,
    },
  ];
}

/**
 * Entries for the afterSign hook, relative to the unpacked app like
 * WINDOWS_NATIVE_RESOURCES. verify-windows-release-signatures.ps1 checks every
 * packaged .exe, so a packaged helper that is not signed fails the release.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function getWindowsPgmHelperSigningPaths(env = process.env) {
  return getWindowsPgmHelperPackagedPaths(env).map(
    (packagedPath) => `resources/${packagedPath}`,
  );
}

/**
 * Helper folders (relative to `resources/`) that need the VC runtime next to
 * the executable: pgm-helper.exe is an /MD build like the other helpers.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function getWindowsPgmHelperVcRuntimeDirs(env = process.env) {
  return isWindowsPgmHelperEnabled(env) ? [WINDOWS_PGM_HELPER_DIR] : [];
}

/**
 * Packaged paths relative to `resources/`, for the smoke tests.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function getWindowsPgmHelperPackagedPaths(env = process.env) {
  return getWindowsPgmHelperResourceEntries(env).map((entry) => entry.to);
}

/**
 * Repo-relative build outputs that must exist before electron-builder runs,
 * for scripts/verify-release-artifacts.sh.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {string[]}
 */
function getWindowsPgmHelperSourcePaths(env = process.env) {
  return getWindowsPgmHelperResourceEntries(env).map((entry) => entry.from);
}

module.exports = {
  WINDOWS_PGM_BUILD_SWITCH,
  WINDOWS_PGM_HELPER_DIR,
  WINDOWS_PGM_HELPER_PACKAGED_PATH,
  WINDOWS_PGM_HELPER_SOURCE_PATH,
  getWindowsPgmHelperPackagedPaths,
  getWindowsPgmHelperResourceEntries,
  getWindowsPgmHelperSigningPaths,
  getWindowsPgmHelperSourcePaths,
  getWindowsPgmHelperVcRuntimeDirs,
  isWindowsPgmHelperEnabled,
};
