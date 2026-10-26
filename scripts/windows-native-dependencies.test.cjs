const assert = require("node:assert/strict");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  parseDumpbinDependents,
  evaluateDependencies,
  isWindowsOsDll,
} = require("./lib/windows-native-dependency-policy.cjs");
const {
  verifyNativeDependencies,
} = require("./verify-windows-native-dependencies.cjs");

// Shape of `dumpbin /NOLOGO /DEPENDENTS display-helper.exe` for an /MD build.
const DISPLAY_HELPER_DUMPBIN = `
Dump of file display-helper.exe

File Type: EXECUTABLE IMAGE

  Image has the following dependencies:

    SDL2.dll
    KERNEL32.dll
    USER32.dll
    SHELL32.dll
    ole32.dll
    MSVCP140.dll
    VCRUNTIME140.dll
    VCRUNTIME140_1.dll
    api-ms-win-crt-runtime-l1-1-0.dll
    api-ms-win-crt-heap-l1-1-0.dll
    api-ms-win-crt-stdio-l1-1-0.dll
    api-ms-win-crt-math-l1-1-0.dll
    api-ms-win-crt-string-l1-1-0.dll
    api-ms-win-crt-locale-l1-1-0.dll
    api-ms-win-crt-convert-l1-1-0.dll
    api-ms-win-crt-utility-l1-1-0.dll

  Summary

        1000 .data
        1000 .pdata
        1000 .rdata
        1000 .reloc
        1000 .rsrc
        1000 .text
`;

const DELAY_LOAD_DUMPBIN = `
Dump of file meeting-helper.exe

File Type: EXECUTABLE IMAGE

  Image has the following dependencies:

    onnxruntime.dll
    KERNEL32.dll
    d3d11.dll
    dxgi.dll
    MFPlat.DLL
    VCRUNTIME140.dll

  Image has the following delay load dependencies:

    openvino.dll
    d3d12.dll

  Summary

        1000 .text
`;

test("parses import names from dumpbin /DEPENDENTS output in order", () => {
  assert.deepEqual(parseDumpbinDependents(DISPLAY_HELPER_DUMPBIN), [
    "SDL2.dll",
    "KERNEL32.dll",
    "USER32.dll",
    "SHELL32.dll",
    "ole32.dll",
    "MSVCP140.dll",
    "VCRUNTIME140.dll",
    "VCRUNTIME140_1.dll",
    "api-ms-win-crt-runtime-l1-1-0.dll",
    "api-ms-win-crt-heap-l1-1-0.dll",
    "api-ms-win-crt-stdio-l1-1-0.dll",
    "api-ms-win-crt-math-l1-1-0.dll",
    "api-ms-win-crt-string-l1-1-0.dll",
    "api-ms-win-crt-locale-l1-1-0.dll",
    "api-ms-win-crt-convert-l1-1-0.dll",
    "api-ms-win-crt-utility-l1-1-0.dll",
  ]);
});

test("includes delay-load dependencies and ignores the summary section", () => {
  assert.deepEqual(parseDumpbinDependents(DELAY_LOAD_DUMPBIN), [
    "onnxruntime.dll",
    "KERNEL32.dll",
    "d3d11.dll",
    "dxgi.dll",
    "MFPlat.DLL",
    "VCRUNTIME140.dll",
    "openvino.dll",
    "d3d12.dll",
  ]);
  assert.deepEqual(parseDumpbinDependents(""), []);
  assert.deepEqual(parseDumpbinDependents("Dump of file x.exe\n\n  Summary\n"), []);
  // Real dumpbin output on Windows uses CRLF line endings.
  assert.deepEqual(
    parseDumpbinDependents(
      "Dump of file x.exe\r\n\r\n  Image has the following dependencies:\r\n\r\n    KERNEL32.dll\r\n    msvcp140.dll\r\n\r\n  Summary\r\n",
    ),
    ["KERNEL32.dll", "msvcp140.dll"],
  );
});

test("OS-only imports are satisfied without any sibling file", () => {
  const result = evaluateDependencies({
    imports: [
      "KERNEL32.dll",
      "USER32.dll",
      "api-ms-win-crt-runtime-l1-1-0.dll",
      "ext-ms-win-ntuser-window-l1-1-0.dll",
      "MFPlat.DLL",
      "mfsensorgroup.dll",
      "ucrtbase.dll",
    ],
    siblingFiles: [],
  });
  assert.deepEqual(result, { ok: true, missing: [] });
  assert.equal(isWindowsOsDll("d3d12.dll"), true);
  assert.equal(isWindowsOsDll("msvcp140.dll"), false);
  assert.equal(isWindowsOsDll("onnxruntime.dll"), false);
});

test("imports satisfied by a sibling file in the same directory are ok", () => {
  const result = evaluateDependencies({
    imports: ["SDL2.dll", "MSVCP140.dll", "VCRUNTIME140.dll", "KERNEL32.dll"],
    siblingFiles: ["SDL2.dll", "msvcp140.dll", "vcruntime140.dll", "display-helper.exe"],
  });
  assert.deepEqual(result, { ok: true, missing: [] });
});

test("a missing CRT DLL is reported by name, OS DLLs are never reported", () => {
  const result = evaluateDependencies({
    imports: parseDumpbinDependents(DISPLAY_HELPER_DUMPBIN),
    siblingFiles: ["SDL2.dll", "display-helper.exe"],
  });
  assert.deepEqual(result, {
    ok: false,
    missing: ["MSVCP140.dll", "VCRUNTIME140.dll", "VCRUNTIME140_1.dll"],
  });
});

test("sibling matching is case-insensitive", () => {
  const result = evaluateDependencies({
    imports: ["MSVCP140.dll", "VCRUNTIME140.dll", "OpenVINO.DLL"],
    siblingFiles: ["MSVCP140.DLL", "vcruntime140.dll", "openvino.dll"],
  });
  assert.deepEqual(result, { ok: true, missing: [] });
});

test("directory verification runs dumpbin per PE file and lists file -> missing import", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "broadify-win-deps-"));
  try {
    const helperDir = path.join(root, "native", "display-helper");
    await mkdir(helperDir, { recursive: true });
    for (const name of ["display-helper.exe", "SDL2.dll", "vcruntime140.dll", "readme.txt"]) {
      await writeFile(path.join(helperDir, name), "pe");
    }
    const inspected = [];
    const runDumpbin = (file) => {
      inspected.push(path.basename(file));
      return path.basename(file) === "display-helper.exe"
        ? DISPLAY_HELPER_DUMPBIN
        : "Dump of file x.dll\n\n  Image has the following dependencies:\n\n    KERNEL32.dll\n\n  Summary\n";
    };

    const failing = await verifyNativeDependencies({
      resourcesDir: root,
      helperDirs: ["native/display-helper"],
      runDumpbin,
    });
    assert.deepEqual(inspected.sort(), ["SDL2.dll", "display-helper.exe", "vcruntime140.dll"]);
    assert.equal(failing.ok, false);
    assert.deepEqual(failing.problems, [
      { file: "native/display-helper/display-helper.exe", missing: "MSVCP140.dll" },
      { file: "native/display-helper/display-helper.exe", missing: "VCRUNTIME140_1.dll" },
    ]);

    for (const name of ["msvcp140.dll", "vcruntime140_1.dll"]) {
      await writeFile(path.join(helperDir, name), "pe");
    }
    const passing = await verifyNativeDependencies({
      resourcesDir: root,
      helperDirs: ["native/display-helper"],
      runDumpbin,
    });
    assert.deepEqual(passing, { ok: true, problems: [], inspected: 5 });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a missing helper directory fails closed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "broadify-win-deps-"));
  try {
    await assert.rejects(
      verifyNativeDependencies({
        resourcesDir: root,
        helperDirs: ["native/meeting-helper"],
        runDumpbin: () => "",
      }),
      /native\/meeting-helper/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
