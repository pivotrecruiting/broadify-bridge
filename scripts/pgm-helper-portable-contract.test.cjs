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
// These checks keep that split true at the source level; the Windows
// executable and its sources are pinned in pgm-helper-windows-contract.test.cjs.
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
    /\n\nstd::unique_ptr<AudioSource> createPairedAudioSource\(const std::string &videoDisplayName, const std::string &videoDeviceId\);\n\n\}/,
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

test("the macOS executable keeps its own block and platform sources", () => {
  assert.match(
    cmake,
    /if\(PGM_HELPER_BUILD_BINARY AND APPLE\)\n[\s\S]*?add_executable\(pgm-helper MACOSX_BUNDLE\n/,
  );
  const mac = cmake.match(/if\(PGM_HELPER_BUILD_BINARY AND APPLE\)\n([\s\S]*?)\nendif\(\)/);
  assert.ok(mac, "macOS executable block");
  for (const source of [
    "src/main.cpp",
    "src/pgm_engine.cpp",
    "src/platform/platform_host_mac.mm",
    "src/capture/uvc_avfoundation.mm",
    "src/capture/synthetic_source.mm",
    "src/capture/frame_holder_mac.mm",
    "src/audio/audio_capture_avfoundation.mm",
    "src/capture/snapshot.mm",
    "src/recorder/mp4_recorder.mm",
  ]) {
    assert.ok(mac[1].includes(source), `${source} belongs to the macOS executable`);
  }
  // None of the plain C++ stand-ins of the Windows build leaks into the macOS helper.
  for (const source of [
    "platform_host_win.cpp",
    "uvc_mediafoundation.cpp",
    "synthetic_source.cpp",
    "frame_holder_portable.cpp",
    "audio_capture_wasapi.cpp",
    "mp4_recorder_stub.cpp",
  ]) {
    assert.ok(!mac[1].includes(source), `${source} must stay out of the macOS executable`);
  }
});
