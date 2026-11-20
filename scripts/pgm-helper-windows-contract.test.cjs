const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009 / docs/bridge/features/pgm-live-preview-windows.md: pgm-helper.exe
// and its Windows sources exist only behind the build switch
// (BROADIFY_PGM_WINDOWS=1, or -DLIVE_STREAM_WITH_WEBRTC=ON for a direct CMake
// build). Without it a Windows build of this directory is what it was before:
// pure modules and their tests. The doctrine holds on Windows too: hardware
// encoder only, native pixel layouts, no converter the helper did not ask for.
const PGM_HELPER = "apps/bridge/native/pgm-helper";
const cmake = read(`${PGM_HELPER}/CMakeLists.txt`);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const WINDOWS_ONLY_SOURCES = [
  "src/platform/platform_host_win.cpp",
  "src/capture/uvc_mediafoundation.cpp",
  "src/audio/audio_capture_wasapi.cpp",
];

test("pgm-helper.exe is built only when the WebRTC part of live-stream was configured", () => {
  assert.equal((cmake.match(/add_executable\(pgm-helper\b/g) || []).length, 2, "one executable per platform");
  const block = cmake.match(
    /\nif\(PGM_HELPER_BUILD_BINARY AND WIN32 AND TARGET live_stream\)\n([\s\S]*?)\nendif\(\)\n/,
  );
  assert.ok(block, "the Windows executable must be gated by the live_stream target");
  assert.match(block[1], /\n  add_executable\(pgm-helper\n/);
  for (const source of [
    "src/main.cpp",
    "src/pgm_engine.cpp",
    ...WINDOWS_ONLY_SOURCES,
    "src/capture/synthetic_source.cpp",
    "src/capture/frame_holder_portable.cpp",
    "src/audio/opus_encoder.cpp",
    "src/recorder/mp4_recorder_stub.cpp",
  ]) {
    assert.ok(block[1].includes(`    ${source}\n`), `${source} belongs to the Windows executable`);
  }
  const link = block[1].match(/target_link_libraries\(pgm-helper PRIVATE ([^)]*)\)/);
  assert.ok(link, "link line of the Windows executable");
  const libraries = link[1].split(/\s+/).filter(Boolean);
  for (const library of ["pgm_core", "live_stream", "opus", "mfreadwrite", "cfgmgr32", "avrt"]) {
    assert.ok(libraries.includes(library), `${library} must be linked`);
  }

  // Outside that block nothing compiles a Windows-only source: no object
  // library, no compile check, no test target.
  const outside = cmake.replace(block[0], "\n");
  for (const source of WINDOWS_ONLY_SOURCES) {
    assert.ok(!outside.includes(path.basename(source)), `${source} must not appear outside the gated block`);
  }
  assert.ok(!cmake.includes("PGM_HELPER_WINDOWS_COMPILE_CHECK"), "the compile check was replaced by the executable");
  assert.ok(!cmake.includes("pgm_helper_portable_objects"));

  // The gate is the target, and live-stream creates it on Windows only inside its opt-in block.
  const liveStream = read("apps/bridge/native/live-stream/CMakeLists.txt");
  const webrtc = liveStream.match(
    /\nif\(LIVE_STREAM_WITH_WEBRTC AND \(APPLE OR WIN32\)\)\n([\s\S]*?)\nendif\(\)\n\nif\(LIVE_STREAM_WITH_MF AND WIN32\)/,
  );
  assert.ok(webrtc, "live-stream WebRTC block");
  assert.equal((liveStream.match(/add_library\(live_stream STATIC/g) || []).length, 2);
  assert.equal((webrtc[1].match(/add_library\(live_stream STATIC/g) || []).length, 2);
});

test("the Windows sources compile to nothing elsewhere and stdout is never line-buffered", () => {
  for (const source of WINDOWS_ONLY_SOURCES) {
    const text = stripComments(read(`${PGM_HELPER}/${source}`)).trim();
    assert.ok(text.startsWith("#if defined(_WIN32)\n"), `${source} must open with the _WIN32 guard`);
    assert.ok(text.endsWith("#endif"), `${source} must close the _WIN32 guard at the end`);
    assert.doesNotMatch(text, /_IOLBF/, source);
    // MSVC reads sources in the ANSI code page unless told otherwise.
    assert.doesNotMatch(read(`${PGM_HELPER}/${source}`), /[^\x00-\x7f]/, `${source} must stay ASCII`);
  }
});

test("the probe lists hardware encoder MFTs by enumeration only", () => {
  // --probe names the encoder candidates without opening anything. The doctrine
  // of the encoder holds for the list too: hardware MFTs only, and exactly the
  // enumeration the encoder itself runs, so the list cannot drift from it.
  const host = stripComments(read(`${PGM_HELPER}/src/platform/platform_host_win.cpp`));
  const enumerations = (source) => [...source.matchAll(/\bMFTEnum(Ex|2)?\s*\(([\s\S]*?)\)\s*;/g)];
  const calls = enumerations(host);
  assert.equal(calls.length, 1, "exactly one MFT enumeration in the Windows host");
  assert.equal(calls[0][1], "Ex", "the enumeration must be MFTEnumEx");
  const encoderCalls = enumerations(stripComments(read("apps/bridge/native/live-stream/src/mf_encoder.cpp")));
  assert.equal(encoderCalls.length, 1);
  const normalize = (text) => text.replace(/\s+/g, " ").trim();
  assert.equal(normalize(calls[0][2]), normalize(encoderCalls[0][2]), "the probe must enumerate with the encoder's own arguments");
  assert.match(calls[0][2], /^MFT_CATEGORY_VIDEO_ENCODER,\s*MFT_ENUM_FLAG_HARDWARE \| MFT_ENUM_FLAG_SORTANDFILTER,/);
  assert.match(host, /MFT_REGISTER_TYPE_INFO inputType = \{MFMediaType_Video, MFVideoFormat_NV12\};/);
  assert.match(host, /MFT_REGISTER_TYPE_INFO outputType = \{MFMediaType_Video, MFVideoFormat_H264\};/);
  for (const forbidden of [
    "MFT_ENUM_FLAG_SYNCMFT",
    "MFT_ENUM_FLAG_ASYNCMFT",
    "MFT_ENUM_FLAG_ALL",
    "MFT_ENUM_FLAG_TRANSCODE_ONLY",
    "ActivateObject",
    "CoCreateInstance",
  ]) {
    assert.ok(!host.includes(forbidden), `${forbidden} must not appear in the Windows host`);
  }

  // Additive: `encoder` stays the plain backend name, the list is its own field and macOS has none.
  const main = read(`${PGM_HELPER}/src/main.cpp`);
  assert.match(main, /",\\"encoder\\":" << probeEncoderJson\(\)/);
  assert.match(main, /\(encoderCandidates\.empty\(\) \? std::string\(\) : ",\\"encoder_candidates\\":" \+ encoderCandidates\)/);
  assert.match(host, /std::string probeEncoderJson\(\) \{ return "\\"mediafoundation\\""; \}/);
  assert.match(
    read(`${PGM_HELPER}/src/platform/platform_host_mac.mm`),
    /std::string probeEncoderCandidatesJson\(\) \{ return ""; \}/,
  );
});

test("the pure modules of this unit stay free of platform code", () => {
  // pgm_core is compiled wherever this directory is built, with or without the switch.
  const core = cmake.match(/add_library\(pgm_core STATIC\n([\s\S]*?)\)/);
  assert.ok(core);
  for (const source of [
    "src/capture/uvc_format_select.cpp",
    "src/capture/snapshot_portable.cpp",
    "src/audio/audio_pairing.cpp",
  ]) {
    assert.ok(core[1].includes(source), `${source} belongs to pgm_core`);
    for (const file of [source, source.replace(/\.cpp$/, ".h")]) {
      const raw = read(`${PGM_HELPER}/${file}`);
      const text = stripComments(raw);
      assert.doesNotMatch(text, /_WIN32|__APPLE__|<windows\.h>|<mf\w*\.h>|CoreVideo|CoreMedia/, file);
      assert.doesNotMatch(raw, /[^\x00-\x7f]/, `${file} must stay ASCII`);
    }
  }
});

test("the UVC reader delivers the device's own layout: no video processor, low latency, asynchronous", () => {
  const uvc = stripComments(read(`${PGM_HELPER}/src/capture/uvc_mediafoundation.cpp`));
  assert.doesNotMatch(uvc, /MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING|MF_SOURCE_READER_ENABLE_ADVANCED_VIDEO_PROCESSING/);
  assert.doesNotMatch(uvc, /MFVideoFormat_RGB32|MFVideoFormat_ARGB32/);
  assert.match(uvc, /SetUINT32\(MF_LOW_LATENCY, TRUE\)/);
  assert.match(uvc, /SetUnknown\(MF_SOURCE_READER_ASYNC_CALLBACK, /);
  assert.match(uvc, /CM_Register_Notification\(/);
  assert.match(uvc, /selectUvcFormat\(candidates\)/);
  // MJPG is decoded to NV12 first, YUY2 second, and reported.
  const nv12 = uvc.indexOf("requestDecodedOutput(reader, mode, MFVideoFormat_NV12)");
  const yuy2 = uvc.indexOf("requestDecodedOutput(reader, mode, MFVideoFormat_YUY2)");
  assert.ok(nv12 > 0 && yuy2 > nv12, "MJPG output order NV12, then YUY2");
  assert.match(uvc, /return session_ && session_->decodesMjpg\(\) \? "mjpg" : "";/);
  const engine = read(`${PGM_HELPER}/src/pgm_engine.cpp`);
  assert.match(engine, /out << ",\\"decode\\":\\"" << jsonEscape\(decode\) << "\\"";/);
});

test("audio is the paired endpoint in shared mode, converted by the audio engine", () => {
  const wasapi = stripComments(read(`${PGM_HELPER}/src/audio/audio_capture_wasapi.cpp`));
  assert.match(wasapi, /AUDCLNT_SHAREMODE_SHARED,/);
  assert.match(
    wasapi,
    /AUDCLNT_STREAMFLAGS_EVENTCALLBACK \| AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM \| AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY/,
  );
  assert.match(wasapi, /pairAudioEndpoint\(videoDisplayName, videoContainerId\(videoDeviceId\), candidates\)/);
  // Never the default device.
  assert.doesNotMatch(wasapi, /GetDefaultAudioEndpoint/);
  assert.match(wasapi, /"pgm_audio_unavailable"|pgm_audio_unavailable/);
});

test("recording answers recording_unsupported where only the recorder stub exists", () => {
  const engine = read(`${PGM_HELPER}/src/pgm_engine.cpp`);
  assert.match(
    engine,
    /std::string PgmEngine::recordingStart\(const std::string &filePath\) \{\n  if \(!Mp4Recorder::supported\(\)\) \{\n    throw RpcFailure\{"recording_unsupported", /,
    "the check must come first in recordingStart",
  );
  assert.match(read(`${PGM_HELPER}/src/recorder/mp4_recorder.mm`), /bool Mp4Recorder::supported\(\) \{ return true; \}/);
  const stub = read(`${PGM_HELPER}/src/recorder/mp4_recorder_stub.cpp`);
  assert.match(stub, /bool Mp4Recorder::supported\(\) \{ return false; \}/);
  assert.match(stub, /bool Mp4Recorder::start\(const std::string &, bool, std::string &error\) \{\n[^}]*return false;\n\}/);
});

test("the build wrapper runs build.ps1 only with BROADIFY_PGM_WINDOWS=1", () => {
  const wrapper = read("scripts/build-pgm-helper.sh");
  const windows = wrapper.match(/\nif \[\[ ([^\n]*) \]\]; then\n  BUILD_PS1="\$ROOT_DIR\/apps\/bridge\/native\/pgm-helper\/build\.ps1"\n/);
  assert.ok(windows, "Windows branch of the wrapper");
  assert.match(windows[1], /"\$\{BROADIFY_PGM_WINDOWS:-\}" == "1"$/);
  assert.equal((wrapper.match(/build\.ps1/g) || []).length, 1, "build.ps1 is reachable through the gated branch only");
  // Without the switch the script ends in the message it always printed.
  assert.ok(
    wrapper.endsWith('echo "Skipping PGM helper build on $UNAME_S (phase 1 ships macOS only)."\nexit 0\n'),
  );

  const ps1 = read(`${PGM_HELPER}/build.ps1`);
  assert.match(ps1, /"-DLIVE_STREAM_WITH_WEBRTC=ON",/);
  assert.match(ps1, /"--target", "pgm-helper"/);

  // No npm script turns the switch on or calls build.ps1 directly, and no
  // release workflow builds the helper itself: a release reaches it only
  // through dist:win -> npm run build:pgm-helper, i.e. through the gate above.
  // Since the packaging unit the release workflows name the switch in one
  // place, the guard of the step that installs the helper's dependencies.
  // That they never set it is pinned, with the packaging lists, in
  // scripts/pgm-helper-windows-release-contract.test.cjs.
  const packageJson = read("package.json");
  assert.ok(!packageJson.includes("BROADIFY_PGM_WINDOWS"));
  assert.ok(!packageJson.includes("pgm-helper/build.ps1"));
  for (const workflow of ["release.yml", "test-release.yml"]) {
    const text = read(`.github/workflows/${workflow}`);
    assert.ok(!text.includes("build-pgm-helper"), workflow);
    assert.doesNotMatch(text, /pgm-helper[\\/]build\.ps1/, workflow);
  }
});

test("the CI workflow builds the helper through the switch and proves there is no software fallback", () => {
  const workflow = read(".github/workflows/pgm-windows-native.yml");
  assert.doesNotMatch(workflow, /\n  helper:\n/, "the compile-only job was replaced");
  const full = workflow.slice(workflow.indexOf("\n  full:\n"));
  assert.match(full, /env:\n          BROADIFY_PGM_WINDOWS: "1"\n        run: \|\n[\s\S]*?bash scripts\/build-pgm-helper\.sh\n/);
  assert.match(full, /unset BROADIFY_PGM_WINDOWS\n/);
  assert.match(full, /\$exe --probe\)/);
  assert.match(full, /'--synthetic-source', '1280x720@30'/);
  assert.match(full, /if \(\$errorEvent\.code -ne 'encoder_unavailable'\) \{ throw /);
  assert.match(full, /\$_\.type -eq 'pgm_encoder_configured'/);
  assert.match(full, /\$recording\.error\.code -ne 'recording_unsupported'/);
  assert.match(full, /verify-windows-native-dependencies\.cjs/);
  assert.match(full, /uses: actions\/upload-artifact@v4\n        with:\n          name: pgm-helper-windows-x64-unsigned-/);
  // Never on a release branch, never publishing anything.
  assert.match(workflow, /\n  push:\n    branches:\n      - "feature\/pgm-win-\*\*"\n/);
  assert.match(workflow, /\npermissions:\n  contents: read\n/);
});
