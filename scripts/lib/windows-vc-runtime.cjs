/**
 * Microsoft Visual C++ runtime shipped next to the Windows native helpers.
 *
 * display-helper.exe and meeting-helper.exe (and the SDL2 / ONNX Runtime /
 * OpenVINO DLLs beside them) are built against the dynamic CRT (/MD). On a PC
 * without the VC++ redistributable the loader fails with STATUS_DLL_NOT_FOUND
 * (0xC0000135) before any helper code runs, so HDMI outputs and the meeting
 * pipeline silently disappear. Windows resolves imports from the executable's
 * own directory first, therefore the redistributable CRT set is packaged into
 * every helper folder; the duplicate per folder is intended. The UCRT
 * (ucrtbase.dll, api-ms-win-crt-*) is an OS component since Windows 10 and is
 * not shipped.
 *
 * Pure module: no file-system access, no side effects. It is the single
 * source of truth for electron-builder.config.cjs (packaging), the release
 * contract tests and, via scripts/list-windows-vc-runtime-paths.cjs, for
 * scripts/verify-release-artifacts.sh and the Windows PowerShell scripts.
 */

/**
 * Complete contents of <VCToolsRedistDir>\x64\Microsoft.VC143.CRT in the
 * Visual Studio 2022 redistributable (the folder Microsoft licenses for
 * application-local deployment). Staged from there by
 * scripts/prepare-windows-vc-runtime.ps1.
 */
const WINDOWS_VC_RUNTIME_DLLS = Object.freeze([
  "concrt140.dll",
  "msvcp140.dll",
  "msvcp140_1.dll",
  "msvcp140_2.dll",
  "msvcp140_atomic_wait.dll",
  "msvcp140_codecvt_ids.dll",
  "vccorlib140.dll",
  "vcruntime140.dll",
  "vcruntime140_1.dll",
]);

/**
 * Helper folders relative to the packaged `resources/` directory, i.e. the
 * `to` directories electron-builder.config.cjs uses for display-helper.exe and
 * meeting-helper.exe.
 */
const WINDOWS_VC_RUNTIME_HELPER_DIRS = Object.freeze([
  "native/display-helper",
  "native/meeting-helper",
]);

/** Gitignored staging folder (repo-relative) filled by the prepare script. */
const WINDOWS_VC_RUNTIME_STAGING_DIR = "build/windows-vc-runtime";

/**
 * electron-builder `extraResources` entries: one per helper folder, copying
 * exactly the CRT set from the staging folder.
 *
 * @returns {Array<{ from: string, to: string, filter: string[] }>}
 */
function getWindowsVcRuntimeResourceEntries() {
  return WINDOWS_VC_RUNTIME_HELPER_DIRS.map((helperDir) => ({
    from: WINDOWS_VC_RUNTIME_STAGING_DIR,
    to: helperDir,
    filter: [...WINDOWS_VC_RUNTIME_DLLS],
  }));
}

/**
 * Packaged DLL paths relative to `resources/` (forward slashes), for the
 * smoke tests and signature verification.
 *
 * @returns {string[]}
 */
function getWindowsVcRuntimePackagedPaths() {
  return WINDOWS_VC_RUNTIME_HELPER_DIRS.flatMap((helperDir) =>
    WINDOWS_VC_RUNTIME_DLLS.map((dll) => `${helperDir}/${dll}`),
  );
}

/**
 * Repo-relative paths of the staged DLLs, required by
 * scripts/verify-release-artifacts.sh before electron-builder runs.
 *
 * @returns {string[]}
 */
function getWindowsVcRuntimeStagedPaths() {
  return WINDOWS_VC_RUNTIME_DLLS.map(
    (dll) => `${WINDOWS_VC_RUNTIME_STAGING_DIR}/${dll}`,
  );
}

module.exports = {
  WINDOWS_VC_RUNTIME_DLLS,
  WINDOWS_VC_RUNTIME_HELPER_DIRS,
  WINDOWS_VC_RUNTIME_STAGING_DIR,
  getWindowsVcRuntimeResourceEntries,
  getWindowsVcRuntimePackagedPaths,
  getWindowsVcRuntimeStagedPaths,
};
