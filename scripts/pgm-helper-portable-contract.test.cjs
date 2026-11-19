const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009 / docs/bridge/features/pgm-live-preview-windows.md: the PGM helper's
// entry point and engine are portable; everything the operating system has to
// provide sits behind platform/platform_host.h and the per-platform factories.
// These checks keep that split, and the "no Windows executable yet" state, true
// at the source level.
const PGM_HELPER = "apps/bridge/native/pgm-helper";
const cmake = read(`${PGM_HELPER}/CMakeLists.txt`);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("the entry point and the engine carry no platform conditionals", () => {
  for (const file of ["src/main.cpp", "src/pgm_engine.cpp"]) {
    const source = stripComments(read(`${PGM_HELPER}/${file}`));
    assert.doesNotMatch(source, /^\s*#\s*(if|ifdef|ifndef|elif)\b/m, file);
    assert.doesNotMatch(
      source,
      /__APPLE__|_WIN32|CFRetain|CFRelease|CVPixelBuffer|CMSampleBuffer/,
      file,
    );
  }
  assert.ok(
    !fs.existsSync(path.join(root, PGM_HELPER, "src/main.mm")),
    "main.mm was replaced by the portable main.cpp",
  );
});

test("the platform factories are declared without platform conditionals", () => {
  const video = stripComments(read(`${PGM_HELPER}/src/capture/video_source.h`));
  assert.doesNotMatch(video, /#\s*if/);
  assert.match(video, /createUvcEnumerator\(\);/);
  assert.match(video, /createSyntheticSource\(uint32_t width, uint32_t height, double fps\);/);

  const audio = stripComments(read(`${PGM_HELPER}/src/audio/audio_source.h`));
  assert.match(
    audio,
    /\n\nstd::unique_ptr<AudioSource> createPairedAudioSource\(const std::string &videoDisplayName\);\n\n\}/,
    "createPairedAudioSource must be declared outside any #if block",
  );

  const recorder = read(`${PGM_HELPER}/src/recorder/mp4_recorder.h`);
  const portable = recorder.slice(0, recorder.indexOf("#if defined(__APPLE__)\n  void appendVideo"));
  assert.match(portable, /void appendVideo\(const EncodedAccessUnit &unit\);/);
  assert.match(portable, /void appendAudio\(const AudioChunk &chunk\);/);

  for (const header of ["src/capture/frame_holder.h", "src/capture/snapshot.h", "src/platform/platform_host.h"]) {
    assert.doesNotMatch(stripComments(read(`${PGM_HELPER}/${header}`)), /#\s*if/, header);
  }
});

test("stdout is never line-buffered on the Windows CRT", () => {
  // setvbuf(stdout, nullptr, _IOLBF, 0) is an invalid parameter on the UCRT (fast-fail 0xC0000409).
  const win = stripComments(read(`${PGM_HELPER}/src/platform/platform_host_win.cpp`));
  assert.doesNotMatch(win, /_IOLBF/);
  assert.match(win, /setvbuf\(stdout, nullptr, _IONBF, 0\)/);
  const mac = stripComments(read(`${PGM_HELPER}/src/platform/platform_host_mac.mm`));
  assert.match(mac, /setvbuf\(stdout, nullptr, _IOLBF, 0\)/);
  assert.doesNotMatch(stripComments(read(`${PGM_HELPER}/src/main.cpp`)), /setvbuf/);
});

test("the helper executable is still macOS-only and the Windows compile check is opt-in", () => {
  const executables = cmake.match(/add_executable\(pgm-helper\b/g) || [];
  assert.equal(executables.length, 1, "exactly one pgm-helper executable");
  assert.match(
    cmake,
    /if\(PGM_HELPER_BUILD_BINARY AND APPLE\)\n[\s\S]*?add_executable\(pgm-helper MACOSX_BUNDLE\n/,
  );
  assert.match(
    cmake,
    /option\(PGM_HELPER_WINDOWS_COMPILE_CHECK "[^"]*" OFF\)\nif\(WIN32 AND PGM_HELPER_WINDOWS_COMPILE_CHECK\)\n\s+add_library\(pgm_helper_portable_objects OBJECT\n/,
  );
  // The Windows platform host appears in that opt-in block only.
  assert.equal(cmake.split("platform_host_win.cpp").length - 1, 1);
  const optIn = cmake.match(
    /if\(WIN32 AND PGM_HELPER_WINDOWS_COMPILE_CHECK\)\n([\s\S]*?)\nendif\(\)/,
  );
  assert.ok(optIn && optIn[1].includes("src/platform/platform_host_win.cpp"));

  // No npm script and no release workflow turns the compile check on.
  assert.ok(!read("package.json").includes("PGM_HELPER_WINDOWS_COMPILE_CHECK"));
  for (const workflow of ["release.yml", "test-release.yml"]) {
    assert.ok(
      !read(`.github/workflows/${workflow}`).includes("PGM_HELPER_WINDOWS_COMPILE_CHECK"),
      workflow,
    );
  }
});
