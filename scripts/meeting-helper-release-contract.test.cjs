const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));

test("native CTest always selects the Release configuration", () => {
  const script = packageJson.scripts["test:meeting-helper-native"];
  assert.match(script, /cmake --build .* --config Release/);
  assert.match(script, /ctest .* --build-config Release/);
});

test("Windows build fails closed when CMake does not enable MODNet", () => {
  // The integrated (Windows-parity) helper gates MODNet via the
  // MEETING_HELPER_ENABLE_MODNET env: default ON, and a missing onnxruntime
  // root is a hard CMake error instead of a silent Vision/CPU-only binary.
  const cmake = read("apps/bridge/native/meeting-helper/CMakeLists.txt");
  const build = read("apps/bridge/native/meeting-helper/build.ps1");
  assert.match(cmake, /DEFINED ENV\{MEETING_HELPER_ENABLE_MODNET\}/);
  assert.match(cmake, /MEETING_HELPER_ENABLE_MODNET STREQUAL "1"/);
  assert.match(cmake, /message\(FATAL_ERROR/);
  assert.match(cmake, /BROADIFY_ENABLE_MODNET=1/);
  assert.match(build, /MEETING_HELPER_ENABLE_MODNET -ne "0"/);
  assert.match(build, /onnxruntime\.dll/);
});

test("Windows meeting-helper dependencies use valid NuGet flat-container paths", () => {
  const dependencyScript = read(
    "scripts/prepare-windows-meeting-helper-deps.ps1",
  );
  assert.match(
    dependencyScript,
    /\$onnxPackageId = "microsoft\.ml\.onnxruntime\.directml"/,
  );
  assert.match(
    dependencyScript,
    /\$directMlPackageId = "microsoft\.ai\.directml"/,
  );
  assert.match(
    dependencyScript,
    /v3-flatcontainer\/\$onnxPackageId\/\$OnnxRuntimeVersion\/\$onnxPackage\.nupkg/,
  );
  assert.match(
    dependencyScript,
    /v3-flatcontainer\/\$directMlPackageId\/\$DirectMLVersion\/\$directMlPackage\.nupkg/,
  );
  assert.doesNotMatch(
    dependencyScript,
    /v3-flatcontainer\/\$onnxPackage\/\$OnnxRuntimeVersion/,
  );
  assert.doesNotMatch(
    dependencyScript,
    /v3-flatcontainer\/\$directMlPackage\/\$DirectMLVersion/,
  );
});

test("Windows distribution enables MODNet before native tests", () => {
  const script = packageJson.scripts["dist:win"];
  const orderedTokens = [
    "download:modnet-model",
    "MEETING_HELPER_ENABLE_MODNET=1",
    "build:meeting-helper",
    "test:meeting-helper-native",
    "verify-release-artifacts.sh --arch x64",
  ];
  let previousIndex = -1;
  for (const token of orderedTokens) {
    const index = script.indexOf(token);
    assert.ok(index > previousIndex, `${token} is missing or out of order`);
    previousIndex = index;
  }
});

// The OpenVINO runtime set shipped next to meeting-helper.exe. Must stay in
// sync across the deps script, the helper build, packaging, signing and the
// smoke tests - these assertions are that sync guard.
const OPENVINO_RUNTIME_FILES = [
  "openvino.dll",
  "openvino_auto_batch_plugin.dll",
  "openvino_auto_plugin.dll",
  "openvino_hetero_plugin.dll",
  "openvino_intel_cpu_plugin.dll",
  "openvino_intel_gpu_plugin.dll",
  "openvino_intel_npu_plugin.dll",
  "openvino_ir_frontend.dll",
  "openvino_onnx_frontend.dll",
  "cache.json",
  "tbb12.dll",
  "tbbbind_2_5.dll",
  "tbbmalloc.dll",
];

test("Windows distribution builds, ships and signs the OpenVINO backend", () => {
  // Build flag: dist:win must enable OpenVINO, and CMake must fail closed
  // when the vendored runtime is missing (same contract as MODNet/ORT).
  const distWin = packageJson.scripts["dist:win"];
  assert.match(distWin, /MEETING_HELPER_ENABLE_OPENVINO=1/);
  const cmake = read("apps/bridge/native/meeting-helper/CMakeLists.txt");
  assert.match(cmake, /DEFINED ENV\{MEETING_HELPER_ENABLE_OPENVINO\}/);
  assert.match(cmake, /BROADIFY_ENABLE_OPENVINO=1/);
  assert.match(cmake, /BROADIFY_ENABLE_OPENVINO=0/);
  assert.match(cmake, /prepare-windows-openvino-deps\.ps1/);

  // Runtime file set: helper build copies it, extraResources packages it,
  // the signing hook signs the DLLs, the smoke tests assert it on disk.
  const build = read("apps/bridge/native/meeting-helper/build.ps1");
  const builderConfig = read("electron-builder.config.cjs");
  const signList = read("scripts/sign-windows-native-resources.cjs");
  const smokeMsi = read("scripts/smoke-test-windows-msi.ps1");
  const helperSmoke = read("scripts/test-windows-meeting-helper.ps1");
  const verifyArtifacts = read("scripts/verify-release-artifacts.sh");
  for (const file of OPENVINO_RUNTIME_FILES) {
    assert.ok(build.includes(file), `build.ps1 must copy ${file}`);
    assert.ok(builderConfig.includes(file), `extraResources must package ${file}`);
    assert.ok(smokeMsi.includes(file), `MSI smoke must expect ${file}`);
    assert.ok(helperSmoke.includes(file), `helper smoke must require ${file}`);
    assert.ok(verifyArtifacts.includes(file), `artifact verification must require ${file}`);
    if (file.endsWith(".dll")) {
      assert.ok(
        signList.includes(`resources/native/meeting-helper/${file}`),
        `signing list must contain ${file}`,
      );
    }
  }
  // cache.json is data and must NOT be in the signing list.
  assert.ok(
    !signList.includes("resources/native/meeting-helper/cache.json"),
    "cache.json must not be signed",
  );
});

test("Windows OpenVINO dependencies are pinned and hash-verified", () => {
  const dependencyScript = read("scripts/prepare-windows-openvino-deps.ps1");
  // Official archive host with the documented layout, exact build pinned.
  assert.match(
    dependencyScript,
    /storage\.openvinotoolkit\.org\/repositories\/openvino\/packages/,
  );
  assert.match(dependencyScript, /\$OpenVinoBuild = "2025\.4\.2\.\d+\.[0-9a-f]+"/);
  // SHA256 pin: a 64-hex default plus a hard verification of the download.
  assert.match(dependencyScript, /\$OpenVinoSha256 = "[0-9a-f]{64}"/);
  assert.match(dependencyScript, /Get-FileHash -Algorithm SHA256/);
  assert.match(dependencyScript, /SHA256 mismatch/);
  // An empty hash parameter must be rejected, never downloaded unverified.
  assert.match(dependencyScript, /IsNullOrWhiteSpace\(\$OpenVinoSha256\)/);
});

test("D3D11 uniform struct stays in sync with its HLSL cbuffer", () => {
  // This lineage mirrors one C++ struct into the HLSL cbuffer inline; the
  // background-image fields prove the company-background ABI is plumbed
  // through both sides, and the sync-guard comment must stay in place.
  const source = read(
    "apps/bridge/native/meeting-helper/src/compose/d3d11_compositor.cpp",
  );
  assert.match(source, /Must match the HLSL cbuffer/);
  const bgImagePresentCount = (source.match(/bgImagePresent/g) ?? []).length;
  assert.ok(
    bgImagePresentCount >= 3,
    "bgImagePresent must exist in the C++ struct, the cbuffer and the kernel",
  );
  assert.match(source, /bgImageTex/);
});

test("Windows GPU compositor keeps its CPU fallback kill-switch", () => {
  // The self-test driver hooks of the previous lineage do not exist here;
  // the fail-safe contract is the runtime kill-switch: the D3D11 compositor
  // can be disabled via env and every failure falls back to the CPU
  // compositor instead of aborting.
  const compositor = read(
    "apps/bridge/native/meeting-helper/src/compose/d3d11_compositor.cpp",
  );
  assert.match(compositor, /BROADIFY_MEETING_GPU_COMPOSITOR_D3D11/);
  assert.match(compositor, /falls back to the CPU compositor/);
});

test("release workflows share the verified Windows dependency installer", () => {
  const release = read(".github/workflows/release.yml");
  const testRelease = read(".github/workflows/test-release.yml");
  for (const workflow of [release, testRelease]) {
    assert.match(workflow, /prepare-windows-meeting-helper-deps\.ps1/);
    assert.match(workflow, /prepare-windows-openvino-deps\.ps1/);
    assert.match(workflow, /smoke-test-windows-msi\.ps1/);
  }
  assert.doesNotMatch(
    testRelease,
    /npm run \$\{\{ matrix\.dist_script \}\} -- --publish=never/,
  );
  for (const secret of [
    "APPLE_SIGNING_IDENTITY",
    "CSC_LINK",
    "APPLE_API_KEY",
    "VCAM_APP_PROVISION_PROFILE",
  ]) {
    assert.match(testRelease, new RegExp(secret));
  }
  assert.match(testRelease, /brew install xcodegen/);
  for (const workflow of [release, testRelease]) {
    assert.match(workflow, /REQUIRED_VARS=\([\s\S]*PRESENTATION_RUNTIME_URL_ARM64/);
    assert.match(workflow, /REQUIRED_VARS=\([\s\S]*PRESENTATION_RUNTIME_SHA256_ARM64/);
  }
  assert.match(release, /Stable releases require RELAY_URL and BRIDGE_RELAY_JWKS_URL/);
  assert.match(release, /matrix\.os == 'macos-15' && secrets\.CSC_LINK/);
  assert.match(release, /matrix\.os == 'windows-2022' && secrets\.AZURE_CLIENT_SECRET/);
});

test("Windows distribution builds, packages, signs and registers the vcam DLL", () => {
  // The virtual camera on Windows is a COM media source DLL loaded by the
  // Frame Server. Historically it was never part of dist:win, so installer
  // machines had no "Broadify Camera" at all - these assertions keep the
  // whole chain wired: build -> extraResources -> signing -> registration.
  const distWin = packageJson.scripts["dist:win"];
  const buildIndex = distWin.indexOf("build:vcam-dll:windows");
  const packIndex = distWin.indexOf("electron-builder");
  assert.ok(buildIndex >= 0, "dist:win must build the vcam DLL");
  assert.ok(buildIndex < packIndex, "the DLL must be built before packaging");
  assert.match(
    packageJson.scripts["build:vcam-dll:windows"],
    /vcam-helper\/windows\/build\.ps1/,
  );

  const builderConfig = read("electron-builder.config.cjs");
  assert.match(
    builderConfig,
    /native\/vcam-helper\/broadify-vcam\.dll/,
    "win extraResources must package the DLL",
  );

  const signList = read("scripts/sign-windows-native-resources.cjs");
  assert.match(signList, /resources\/native\/vcam-helper\/broadify-vcam\.dll/);

  const builderJson = JSON.parse(read("electron-builder.json"));
  assert.equal(builderJson.nsis.include, "build/windows-installer.nsh");
  // regsvr32 writes HKLM: only a per-machine (elevated) install can register
  // the class. A per-user install ("Only for me") silently produced
  // 0x80040154 at runtime. packElevateHelper keeps electron-updater able to
  // elevate the silent update of a per-machine install.
  assert.equal(builderJson.nsis.perMachine, true);
  assert.equal(builderJson.nsis.packElevateHelper, true);
  assert.equal(builderJson.nsis.oneClick, false);
  const installerScript = read("build/windows-installer.nsh");
  assert.match(installerScript, /customInstall/);
  assert.match(installerScript, /customUnInstall/);
  // Sysnative, not System32: the 32-bit NSIS process must reach the 64-bit
  // regsvr32 or the CLSID lands under WOW6432Node where the Frame Server
  // never looks.
  assert.match(installerScript, /Sysnative\\regsvr32\.exe/);
  // The regsvr32 exit code must be checked and reported (details pane,
  // error level, message box unless silent) instead of DetailPrint-only.
  assert.match(installerScript, /regsvr32 exit code: \$0/);
  assert.match(installerScript, /\$\{If\} \$0 != 0/);
  assert.match(installerScript, /SetErrorLevel 3/);
  assert.match(installerScript, /\$\{IfNot\} \$\{Silent\}[\s\S]*MessageBox MB_OK\|MB_ICONEXCLAMATION/);
  assert.doesNotMatch(installerScript, /\bAbort\b/);
  // Uninstall: the DLL is already deleted when customUnInstall runs, so
  // regsvr32 /u cannot work - the CLSID key is removed directly (64-bit view).
  const vcamGuidHeader = read("apps/bridge/native/vcam-helper/windows/vcam_guid.h");
  const clsid = "{8B1E9E3A-7C4D-4E2B-9F1A-2D6C5B0A9E77}";
  assert.ok(vcamGuidHeader.includes(clsid), "vcam_guid.h must define the CLSID");
  assert.ok(installerScript.includes(`!define BROADIFY_VCAM_CLSID "${clsid}"`));
  assert.match(installerScript, /SetRegView 64/);
  assert.match(
    installerScript,
    /DeleteRegKey HKLM "\$\{BROADIFY_VCAM_CLSID_KEY\}"/,
  );
  assert.match(
    installerScript,
    /BROADIFY_VCAM_CLSID_KEY "Software\\Classes\\CLSID\\\$\{BROADIFY_VCAM_CLSID\}"/,
  );
  assert.doesNotMatch(installerScript, /regsvr32\.exe" \/u/);
  // The NSIS smoke test must prove the installer (not the test) registered
  // the class, and that uninstall removed it again.
  const smokeNsis = read("scripts/smoke-test-windows-nsis.ps1");
  assert.ok(smokeNsis.includes(clsid), "NSIS smoke must assert the CLSID");
  assert.match(smokeNsis, /InprocServer32/);
  assert.match(smokeNsis, /\$env:ProgramFiles/);
  const selfHeal = read(
    "apps/bridge/src/services/meeting/vcam-registration-self-heal.ts",
  );
  assert.ok(selfHeal.includes(clsid), "self-heal must probe the same CLSID");

  const verifyArtifacts = read("scripts/verify-release-artifacts.sh");
  assert.match(
    verifyArtifacts,
    /vcam-helper\/windows\/broadify-vcam\.dll/,
    "artifact verification must require the built DLL",
  );
});

test("packaged macOS helper verifies the model hashes", () => {
  // The runtime self-test hooks retired with the previous helper lineage;
  // the packaged-model hash verification is the remaining hard gate here.
  const verification = read("scripts/verify-macos-release-signing.sh");
  assert.match(verification, /packaged CoreML model hashes verified/);
  assert.doesNotMatch(verification, /--self-test/);
});

test("release runs the local build before the normal tag flow", () => {
  const releaseScript = read("scripts/push-release.mjs");
  const buildIndex = releaseScript.lastIndexOf(
    'run("npm", ["run", "build"], dryRun)',
  );
  const versionIndex = releaseScript.lastIndexOf(
    'run("npm", ["version", "--no-git-tag-version"',
  );
  const tagIndex = releaseScript.lastIndexOf(
    'run("git", ["tag", "-a", nextTag',
  );
  const branchPushIndex = releaseScript.lastIndexOf(
    'run("git", ["push", "origin", releaseBranch]',
  );
  const tagPushIndex = releaseScript.lastIndexOf(
    'run("git", ["push", "origin", nextTag]',
  );
  assert.ok(buildIndex >= 0, "local npm build is missing");
  assert.ok(versionIndex > buildIndex, "local build must pass before versioning");
  assert.ok(tagIndex > versionIndex, "normal RC tag creation is missing");
  assert.ok(
    branchPushIndex > tagIndex,
    "release branch push must follow tag creation",
  );
  assert.ok(
    tagPushIndex > branchPushIndex,
    "tag push must finish the normal release flow",
  );
  assert.doesNotMatch(
    releaseScript,
    /runPackagePreflight|test-release\.yml|gh.*run.*watch/s,
  );
});
