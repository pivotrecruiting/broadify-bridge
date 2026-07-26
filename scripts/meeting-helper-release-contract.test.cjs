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
