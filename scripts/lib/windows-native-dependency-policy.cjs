/**
 * Dependency policy for the packaged Windows native helpers.
 *
 * The release runner has the VC++ redistributable installed, so the helper
 * smoke tests cannot notice a CRT DLL that is missing from the package. This
 * module turns `dumpbin /DEPENDENTS` output into a verdict: every import must
 * be either an inbox Windows DLL or a file packaged in the same directory as
 * the importing exe/dll (which is where the loader looks first).
 *
 * Pure module: no file-system or process access.
 */

/**
 * API-set and extension-set contracts (api-ms-win-core-*, api-ms-win-crt-*
 * for the UCRT, ext-ms-win-*) are forwarded by the OS loader and are never
 * shipped by applications.
 */
const WINDOWS_OS_DLL_PREFIXES = Object.freeze(["api-ms-win-", "ext-ms-"]);

/**
 * Inbox Windows DLLs (Windows 10 21H2+ / Windows 11) the helpers and their
 * vendored runtimes import. Derived from:
 * - display-helper: apps/bridge/native/display-helper/build.ps1 link line
 *   (User32, Gdi32, Shell32, Winmm, Imm32, Ole32, OleAut32, Version, Setupapi,
 *   Dxgi) plus the static imports of the vcpkg SDL2.dll.
 * - meeting-helper: CMakeLists.txt WIN32 target_link_libraries (ws2_32, mf,
 *   mfplat, mfreadwrite, ole32, shlwapi, shell32, d3d11, dxgi, d3d12,
 *   d3dcompiler, avrt, winmm, dbghelp, advapi32, windowsapp -> combase and
 *   api-ms-win-core-winrt-*, dwmapi) and the runtime-loaded mfsensorgroup.
 * - vendored onnxruntime / DirectML / OpenVINO / TBB DLLs: kernel32,
 *   advapi32, bcrypt, crypt32, dxcore, d3d12, ucrtbase and friends.
 * - common inbox libraries any MSVC-built PE may pull in (ntdll, kernelbase,
 *   rpcrt4, msvcrt, secur32, psapi, ...).
 *
 * Extend only for DLLs that ship with every supported Windows release; a
 * third-party DLL must be packaged next to the helper instead.
 */
const WINDOWS_OS_DLLS = Object.freeze(
  new Set([
    "advapi32.dll",
    "avrt.dll",
    "bcrypt.dll",
    "cfgmgr32.dll",
    "combase.dll",
    "comctl32.dll",
    "comdlg32.dll",
    "crypt32.dll",
    "d2d1.dll",
    "d3d10.dll",
    "d3d11.dll",
    "d3d12.dll",
    "d3d9.dll",
    "d3dcompiler_47.dll",
    "dbghelp.dll",
    "dcomp.dll",
    "dinput8.dll",
    "dwmapi.dll",
    "dwrite.dll",
    "dxcore.dll",
    "dxgi.dll",
    "dxva2.dll",
    "evr.dll",
    "gdi32.dll",
    "gdiplus.dll",
    "hid.dll",
    "imm32.dll",
    "iphlpapi.dll",
    "kernel32.dll",
    "kernelbase.dll",
    "mf.dll",
    "mfcore.dll",
    "mfplat.dll",
    "mfreadwrite.dll",
    "mfsensorgroup.dll",
    "mmdevapi.dll",
    "msvcrt.dll",
    "mswsock.dll",
    "netapi32.dll",
    "ntdll.dll",
    "ole32.dll",
    "oleacc.dll",
    "oleaut32.dll",
    "opengl32.dll",
    "powrprof.dll",
    "propsys.dll",
    "psapi.dll",
    "rpcrt4.dll",
    "secur32.dll",
    "setupapi.dll",
    "shcore.dll",
    "shell32.dll",
    "shlwapi.dll",
    "ucrtbase.dll",
    "user32.dll",
    "userenv.dll",
    "uxtheme.dll",
    "version.dll",
    "windowscodecs.dll",
    "winhttp.dll",
    "wininet.dll",
    "winmm.dll",
    "wintrust.dll",
    "ws2_32.dll",
    "xinput1_4.dll",
  ]),
);

/**
 * Imports that are provided by a GPU driver, not by Windows and not by us,
 * keyed by the importing file. These files are optional plugins loaded at
 * runtime only when that hardware is present (the driver then also installs
 * the DLL into System32); on a machine without it the plugin simply does not
 * load and the backend falls back. Listing them here keeps the gate strict
 * for every other file: an unexpected OpenCL import in meeting-helper.exe
 * would still fail.
 */
const DRIVER_PROVIDED_IMPORTS = Object.freeze({
  // OpenVINO Intel GPU plugin -> OpenCL ICD loader from the Intel graphics
  // driver. Rationale: the plugin is loaded by openvino.dll only when the
  // Intel GPU device is selected (scripts/prepare-windows-openvino-deps.ps1).
  "openvino_intel_gpu_plugin.dll": Object.freeze(["opencl.dll"]),
});

const DLL_NAME_PATTERN = /^[\w.+-]+\.dll$/i;
const DEPENDENCY_SECTION_PATTERN = /following(?: delay load)? dependencies:/i;

function normalizeDllName(name) {
  return String(name).trim().toLowerCase();
}

/**
 * True when the import is satisfied by the operating system.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isWindowsOsDll(name) {
  const normalized = normalizeDllName(name);
  if (WINDOWS_OS_DLLS.has(normalized)) {
    return true;
  }
  return WINDOWS_OS_DLL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Extracts the imported DLL names (static and delay-load sections, in order,
 * de-duplicated) from `dumpbin /DEPENDENTS` output.
 *
 * @param {string} text
 * @returns {string[]}
 */
function parseDumpbinDependents(text) {
  const imports = [];
  const seen = new Set();
  let inDependencySection = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "") {
      continue;
    }
    if (DEPENDENCY_SECTION_PATTERN.test(line)) {
      inDependencySection = true;
      continue;
    }
    if (!inDependencySection) {
      continue;
    }
    if (!DLL_NAME_PATTERN.test(line)) {
      // "Summary" or any other heading ends the dependency list.
      inDependencySection = false;
      continue;
    }
    const key = normalizeDllName(line);
    if (!seen.has(key)) {
      seen.add(key);
      imports.push(line);
    }
  }

  return imports;
}

/**
 * Checks every import against the OS allowlist and the files packaged next to
 * the importing binary (case-insensitive, as the Windows loader matches).
 *
 * @param {{ imports: string[], siblingFiles: string[], file?: string }} input
 *   `file` is the importing file's name; it unlocks DRIVER_PROVIDED_IMPORTS.
 * @returns {{ ok: boolean, missing: string[] }}
 */
function evaluateDependencies({ imports, siblingFiles, file }) {
  const siblings = new Set((siblingFiles ?? []).map(normalizeDllName));
  const driverProvided = new Set(
    (file ? DRIVER_PROVIDED_IMPORTS[normalizeDllName(file)] : undefined) ?? [],
  );
  const missing = [];
  for (const name of imports ?? []) {
    const normalized = normalizeDllName(name);
    if (
      isWindowsOsDll(name) ||
      siblings.has(normalized) ||
      driverProvided.has(normalized)
    ) {
      continue;
    }
    missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

module.exports = {
  DRIVER_PROVIDED_IMPORTS,
  WINDOWS_OS_DLLS,
  WINDOWS_OS_DLL_PREFIXES,
  evaluateDependencies,
  isWindowsOsDll,
  parseDumpbinDependents,
};
