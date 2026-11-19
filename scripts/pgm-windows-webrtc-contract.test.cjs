const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009: the Windows build of the WebRTC part (libdatachannel + static
// OpenSSL from vcpkg) is opt-in. Without -DLIVE_STREAM_WITH_WEBRTC=ON or the
// build switch BROADIFY_PGM_WINDOWS=1 a Windows release configures no network
// dependency and no new target; macOS keeps building it unconditionally.
const LIVE_STREAM = "apps/bridge/native/live-stream";
const cmake = read(`${LIVE_STREAM}/CMakeLists.txt`);

test("the WebRTC part defaults to ON on macOS and OFF everywhere else", () => {
  const option = cmake.match(
    /if\(NOT DEFINED LIVE_STREAM_WITH_WEBRTC\)\n([\s\S]*?)\nendif\(\)\n/,
  );
  assert.ok(option, "LIVE_STREAM_WITH_WEBRTC default block must exist");
  assert.equal(
    option[1],
    [
      "  if(APPLE)",
      "    set(LIVE_STREAM_WITH_WEBRTC ON)",
      '  elseif(WIN32 AND "$ENV{BROADIFY_PGM_WINDOWS}" STREQUAL "1")',
      "    set(LIVE_STREAM_WITH_WEBRTC ON)",
      "  else()",
      "    set(LIVE_STREAM_WITH_WEBRTC OFF)",
      "  endif()",
    ].join("\n"),
  );
  // Nothing else may switch it on behind the caller's back.
  assert.equal((cmake.match(/set\(LIVE_STREAM_WITH_WEBRTC ON\)/g) || []).length, 2);
});

test("libdatachannel is fetched once, pinned, and only inside the WebRTC block", () => {
  const block = cmake.match(
    /\nif\(LIVE_STREAM_WITH_WEBRTC AND \(APPLE OR WIN32\)\)\n([\s\S]*?)\nendif\(\)\n\nif\(LIVE_STREAM_WITH_MF AND WIN32\)/,
  );
  assert.ok(block, "the WebRTC block must be gated by LIVE_STREAM_WITH_WEBRTC");
  const outside = cmake.replace(block[0], "");
  for (const name of [
    "FetchContent",
    "OPENSSL_",
    "src/publisher.cpp",
    "webrtc_loopback_test",
    "LibDataChannel::",
  ]) {
    assert.ok(block[1].includes(name), `${name} must be inside the WebRTC block`);
    assert.ok(!outside.includes(name), `${name} must not appear outside the WebRTC block`);
  }
  assert.equal((cmake.match(/FetchContent_Declare\(/g) || []).length, 1);
  assert.match(block[1], /GIT_TAG v\d+\.\d+\.\d+\n/);
  assert.match(block[1], /set\(OPENSSL_USE_STATIC_LIBS TRUE CACHE BOOL "" FORCE\)/);
  assert.match(block[1], /set\(USE_MBEDTLS OFF CACHE BOOL "" FORCE\)/);
  assert.match(block[1], /set\(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE\)/);
});

test("the Windows publisher links the Media Foundation encoder and the static libdatachannel", () => {
  const link = cmake.match(
    /add_library\(live_stream STATIC\n\s+src\/publisher\.cpp\n\s+\)\n[\s\S]*?target_link_libraries\(live_stream PUBLIC ([\s\S]*?)\)/,
  );
  assert.ok(link, "Windows live_stream target must exist");
  const libs = link[1].split(/\s+/).filter(Boolean);
  for (const lib of [
    "live_stream_core",
    "live_stream_mf",
    "LibDataChannel::LibDataChannelStatic",
    "mf",
    "mfplat",
    "mfuuid",
    "mfreadwrite",
    "ole32",
    "ws2_32",
    "crypt32",
    "bcrypt",
    "iphlpapi",
  ]) {
    assert.ok(libs.includes(lib), `${lib} must be linked`);
  }
  // WebRTC on Windows implies the encoder, never the other way round.
  assert.match(
    cmake,
    /if\(WIN32 AND LIVE_STREAM_WITH_WEBRTC AND NOT LIVE_STREAM_WITH_MF\)\n[^\n]*\n\s+set\(LIVE_STREAM_WITH_MF ON\)\nendif\(\)/,
  );
});

test("the vcpkg manifest pins OpenSSL and the deps script installs it statically", () => {
  const manifest = JSON.parse(read(`${LIVE_STREAM}/vcpkg.json`));
  assert.match(manifest["builtin-baseline"], /^[0-9a-f]{40}$/);
  assert.deepEqual(manifest.dependencies, ["openssl"]);

  const script = read("scripts/prepare-windows-pgm-deps.ps1");
  assert.match(script, /\$Triplet = "x64-windows-static-md"/);
  assert.match(script, /apps\\bridge\\native\\live-stream/);
  assert.match(script, /"--x-manifest-root=\$manifestRoot"/);
  assert.match(script, /deps\\vcpkg_installed/);
  // CMake reads the same tree and uses no vcpkg toolchain file.
  assert.match(
    cmake,
    /\$\{CMAKE_CURRENT_SOURCE_DIR\}\/deps\/vcpkg_installed\/x64-windows-static-md/,
  );
  assert.doesNotMatch(cmake, /CMAKE_TOOLCHAIN_FILE/);
});

test("the vcpkg install tree is ignored by git", () => {
  const probe = `${LIVE_STREAM}/deps/vcpkg_installed/x64-windows-static-md/lib/libssl.lib`;
  const out = execFileSync("git", ["check-ignore", probe], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(out.trim(), probe);
});

test("no release script or packaging list knows the Windows deps script", () => {
  const packageJson = JSON.parse(read("package.json"));
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.ok(
      !command.includes("prepare-windows-pgm-deps"),
      `npm script ${name} must not run the opt-in deps script`,
    );
  }
  for (const workflow of ["release.yml", "test-release.yml"]) {
    const source = read(`.github/workflows/${workflow}`);
    assert.ok(!source.includes("prepare-windows-pgm-deps"), workflow);
    assert.ok(!source.includes("BROADIFY_PGM_WINDOWS"), workflow);
  }
});

test("the release contract suite runs these checks", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["test:release-contracts"],
    /scripts\/pgm-windows-webrtc-contract\.test\.cjs/,
  );
});
