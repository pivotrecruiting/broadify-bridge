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
  const cmake = read("apps/bridge/native/meeting-helper/CMakeLists.txt");
  const build = read("apps/bridge/native/meeting-helper/build.ps1");
  assert.match(cmake, /option\(MEETING_HELPER_ENABLE_MODNET/);
  assert.match(cmake, /if\(MEETING_HELPER_ENABLE_MODNET\)/);
  assert.match(build, /-DMEETING_HELPER_ENABLE_MODNET:BOOL=\$modnetEnabled/);
  assert.match(build, /CMake MODNet configuration mismatch/);
  assert.match(build, /dumpbin\.exe \/DEPENDENTS/);
  assert.match(build, /imports onnxruntime\.dll/);
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
    "test:meeting-helper-gpu",
    "test:meeting-helper-keyer",
    "verify-release-artifacts.sh --arch x64",
  ];
  let previousIndex = -1;
  for (const token of orderedTokens) {
    const index = script.indexOf(token);
    assert.ok(index > previousIndex, `${token} is missing or out of order`);
    previousIndex = index;
  }
});

test("D3D11 host buffer uses the shared GPU uniform ABI", () => {
  const source = read(
    "apps/bridge/native/meeting-helper/src/compose/d3d11_compositor.cpp",
  );
  assert.match(source, /sizeof\(GpuComposeUniforms\)/);
  assert.doesNotMatch(source, /sizeof\(ComposeUniforms\)/);
});

test("hosted Windows self-tests have explicit portable fallbacks", () => {
  const compositor = read(
    "apps/bridge/native/meeting-helper/src/compose/d3d11_compositor.cpp",
  );
  const main = read("apps/bridge/native/meeting-helper/src/main.cpp");
  const installedSmoke = read("scripts/test-windows-meeting-helper.ps1");
  const keyer = read(
    "apps/bridge/native/meeting-helper/src/keyer/modnet_keyer.cpp",
  );
  assert.match(compositor, /BROADIFY_MEETING_GPU_SELF_TEST_DRIVER/);
  assert.match(compositor, /d3d11CompositorSelfTestAvailable/);
  assert.match(main, /BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER/);
  assert.match(main, /forceCpuProvider\s*\? result\.status\.provider == "cpu"/);
  assert.match(main, /result\.hardwareAccelerated == expectedAcceleration/);
  assert.match(keyer, /forceCpuProvider/);
  assert.match(keyer, /options_\.keyerSelfTest/);
  assert.match(installedSmoke, /RequireHardwareAcceleration/);
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

test("packaged macOS helper verifies the model and executes both runtime paths", () => {
  const verification = read("scripts/verify-macos-release-signing.sh");
  assert.match(verification, /packaged CoreML model hashes verified/);
  assert.match(verification, /\"\$HELPER_EXEC_PATH\" --self-test/);
  assert.match(verification, /--keyer-self-test --models-dir/);
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
