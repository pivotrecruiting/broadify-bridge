const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009: the meeting helper's WebRTC program stream is built on Windows
// only behind the build switch BROADIFY_PGM_WINDOWS=1. Without it a Windows
// release links the stub exactly as before: same sources, same configure
// command, no new target. macOS keeps building the stream unconditionally.
const MEETING_HELPER = "apps/bridge/native/meeting-helper";
const LIVE = `${MEETING_HELPER}/src/live`;
const cmake = read(`${MEETING_HELPER}/CMakeLists.txt`);
const buildPs1 = read(`${MEETING_HELPER}/build.ps1`);

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// The if/elseif/else that picks the program stream sources of the helper binary.
function programStreamBlock() {
  const block = cmake.match(
    /\nif\(APPLE\)\n  # Program stream:[\s\S]*?\nendif\(\)\ntarget_link_libraries\(meeting-helper PRIVATE helper_common\)\n/,
  );
  assert.ok(block, "the program stream block of meeting-helper must exist");
  return block[0];
}

test("without the switch a Windows build links the stub program stream, as before", () => {
  const block = programStreamBlock();
  // Byte for byte the branch every non-Apple build took before the switch existed.
  assert.ok(
    block.endsWith(
      [
        "else()",
        "  list(APPEND MEETING_HELPER_SOURCES src/live/program_stream_stub.cpp)",
        "  add_executable(meeting-helper ${MEETING_HELPER_SOURCES})",
        "  target_link_libraries(meeting-helper PRIVATE live_stream_core)",
        "endif()",
        "target_link_libraries(meeting-helper PRIVATE helper_common)",
        "",
      ].join("\n"),
    ),
    "the default branch of the program stream block changed",
  );
  // The helper never turns the WebRTC part on by itself.
  assert.doesNotMatch(cmake, /set\(LIVE_STREAM_WITH_(WEBRTC|MF)\b/);
  assert.doesNotMatch(cmake, /BROADIFY_PGM_WINDOWS\}/);
  assert.doesNotMatch(cmake, /FetchContent/);
});

test("the Windows program stream exists only where live-stream built its WebRTC part", () => {
  const block = programStreamBlock();
  const windows = block.match(
    /\nelseif\(WIN32 AND TARGET live_stream\)\n([\s\S]*?)\nelse\(\)\n/,
  );
  assert.ok(windows, "the Windows branch must be gated by the live_stream target");
  assert.match(
    windows[1],
    /list\(APPEND MEETING_HELPER_SOURCES src\/live\/program_stream\.cpp src\/live\/program_frame_converter_nv12\.cpp\)/,
  );
  assert.match(windows[1], /target_link_libraries\(meeting-helper PRIVATE live_stream\)/);
  assert.doesNotMatch(windows[1], /program_stream_stub/);

  const apple = block.match(/\nif\(APPLE\)\n([\s\S]*?)\nelseif\(/);
  assert.ok(apple);
  assert.match(
    apple[1],
    /list\(APPEND MEETING_HELPER_SOURCES src\/live\/program_stream\.cpp src\/live\/program_frame_converter_vt\.mm\)/,
  );

  // Everything else that names the real stream sits behind the same target check.
  const tests = cmake.match(
    /\n  if\(TARGET live_stream\)\n([\s\S]*?)\n  endif\(\)\nendif\(\)\n$/,
  );
  assert.ok(tests, "the stream tests must be gated by the live_stream target");
  const outside = cmake.replace(block, "").replace(tests[0], "");
  for (const name of [
    "src/live/program_stream.cpp",
    "program_frame_converter_nv12",
    "program_stream_loopback_test",
  ]) {
    assert.ok(tests[1].includes(name), `${name} must be part of the gated stream tests`);
    assert.ok(!outside.includes(name), `${name} must not be referenced outside the gated blocks`);
  }
  // The RPC tests keep linking the stub on every platform.
  assert.match(outside, /set\(CONTROL_SERVER_TEST_SOURCES[\s\S]*?src\/live\/program_stream_stub\.cpp/);
});

test("build.ps1 passes the WebRTC arguments only with BROADIFY_PGM_WINDOWS=1", () => {
  const branches = buildPs1.match(
    /\nif \(\$env:BROADIFY_PGM_WINDOWS -eq "1"\) \{\n([\s\S]*?)\n\} else \{\n([\s\S]*?)\n\}\nInvoke-NativeCommand cmake --build /,
  );
  assert.ok(branches, "build.ps1 must branch on the build switch before configuring");
  const [, withSwitch, withoutSwitch] = branches;
  assert.match(withSwitch, /"-DLIVE_STREAM_WITH_WEBRTC=ON"/);
  assert.match(withSwitch, /MEETING_HELPER_CMAKE_EXTRA_ARGS/);
  // The release's configure command, unchanged.
  assert.match(
    withoutSwitch,
    /\n  Invoke-NativeCommand cmake -S \$rootDir -B \$buildDir -DCMAKE_BUILD_TYPE=\$Config$/,
  );
  assert.equal((withoutSwitch.match(/\bcmake\b/g) || []).length, 1);
  assert.doesNotMatch(withoutSwitch, /-DLIVE_STREAM|EXTRA_ARGS|OPENSSL/);
  // A build directory left over from a build with the switch is refused, not reused.
  assert.match(withoutSwitch, /CMakeCache\.txt/);
  assert.match(withoutSwitch, /LIVE_STREAM_WITH_WEBRTC/);
  assert.match(withoutSwitch, /\bthrow\b/);
  // Outside the two branches nothing knows the switch.
  const rest = buildPs1.replace(branches[0], "");
  assert.doesNotMatch(rest, /BROADIFY_PGM_WINDOWS|LIVE_STREAM|MEETING_HELPER_CMAKE_EXTRA_ARGS/);
});

test("no npm script and no release workflow sets the build switch", () => {
  const packageJson = JSON.parse(read("package.json"));
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.ok(
      !/BROADIFY_PGM_WINDOWS\s*=/.test(command),
      `npm script ${name} must not set the build switch`,
    );
  }
  assert.doesNotMatch(read("scripts/build-meeting-helper.sh"), /BROADIFY_PGM_WINDOWS|LIVE_STREAM/);
  for (const workflow of ["release.yml", "test-release.yml"]) {
    assert.doesNotMatch(
      read(`.github/workflows/${workflow}`),
      /BROADIFY_PGM_WINDOWS\s*[:=]\s*["']?1/,
      workflow,
    );
  }
});

test("the stream worker is portable and the NV12 converter is pure C++", () => {
  const worker = stripComments(read(`${LIVE}/program_stream.cpp`));
  for (const pattern of [
    /#\s*import\b/,
    /#\s*if/,
    /\bCV[A-Z]\w+/,
    /\bCF(Release|Retain)\b/,
    /\bIMF\w+/,
    /windows\.h/,
    /program_frame_converter_(vt|nv12)/,
  ]) {
    assert.doesNotMatch(worker, pattern, `program_stream.cpp must stay free of ${pattern}`);
  }
  assert.match(worker, /createProgramFrameConverter\(\)/);
  assert.match(worker, /live::createHardwareEncoder\(\)/);

  // The same file is the Windows converter and a ctest target on macOS.
  const converter = stripComments(read(`${LIVE}/program_frame_converter_nv12.cpp`));
  for (const pattern of [/#\s*if/, /windows\.h/, /\bmf\w*\.h\b/, /\bIMF\w+/, /\bMF[A-Z]\w+/, /nativeHandle = (?!nullptr)/]) {
    assert.doesNotMatch(converter, pattern, `program_frame_converter_nv12.cpp must stay free of ${pattern}`);
  }
  assert.match(converter, /bool runsUnderStoreLock\(\) const override \{ return false; \}/);

  // macOS keeps today's hand-over: under the store lock, a new encoder attempt with every frame.
  const vt = stripComments(read(`${LIVE}/program_frame_converter_vt.mm`));
  assert.match(vt, /bool runsUnderStoreLock\(\) const override \{ return true; \}/);
  assert.match(
    vt,
    /std::chrono::milliseconds encoderRetryInterval\(\) const override \{ return std::chrono::milliseconds\(0\); \}/,
  );
});

test("the Windows workflow builds and tests the meeting helper in both configurations", () => {
  const workflow = read(".github/workflows/pgm-windows-native.yml");
  // Pushes that touch the helper trigger the workflow.
  assert.match(workflow, /\n {6}- apps\/bridge\/native\/meeting-helper\/\*\*\n/);
  const job = workflow.match(/\n {2}meeting:\n([\s\S]*)$/);
  assert.ok(job, "job meeting must exist");
  const body = job[1];
  assert.match(body, /fail-fast: false/);
  assert.match(body, /pgm_windows: "0"/);
  assert.match(body, /pgm_windows: "1"/);
  // Matting backends as dist:win builds them; OpenVINO through the release's own script.
  assert.match(body, /MEETING_HELPER_ENABLE_MODNET: "1"/);
  assert.match(body, /\.\/scripts\/prepare-windows-openvino-deps\.ps1\n/);
  assert.match(body, /"MEETING_HELPER_ENABLE_OPENVINO=1" \| Out-File -FilePath \$env:GITHUB_ENV/);

  // One entry per step, without the comment block that introduces the next one.
  const steps = body
    .split(/\n {6}- name: /)
    .slice(1)
    .map((step) => step.replace(/\n\n {6}#[\s\S]*$/, "\n"));
  const defaultSteps = steps.filter((step) => /\n {8}if: matrix\.pgm_windows != '1'\n/.test(step));
  const switchSteps = steps.filter((step) => /\n {8}if: matrix\.pgm_windows == '1'/.test(step));
  assert.ok(switchSteps.length >= 5, "switch configuration: dependencies, build, tests");
  // Default: the release's two commands, then the check that nothing of the live program was built.
  assert.equal(defaultSteps.length, 3);
  const [build, buildAllAndTest, assertNothing] = defaultSteps;
  assert.match(build, /\n {10}npm run build:meeting-helper\n/);
  assert.match(buildAllAndTest, /\n {10}npm run test:meeting-helper-native\n/);
  for (const step of [build, buildAllAndTest]) {
    assert.equal((step.match(/\bnpm run\b/g) || []).length, 2, "one npm command and its error text per step");
    assert.doesNotMatch(step, /LIVE_STREAM|MEETING_HELPER_CMAKE_EXTRA_ARGS|\bcmake\b|\bctest\b/);
  }
  assert.match(assertNothing, /program_stream_stub\.obj/);
  for (const step of defaultSteps) {
    assert.doesNotMatch(step, /\n {8}env:/, "a default step must not set its own environment");
  }
  const switched = switchSteps.join("\n");
  assert.match(switched, /BROADIFY_PGM_WINDOWS: "1"/);
  assert.match(switched, /\n {10}npm run build:meeting-helper\n/);
  assert.match(switched, /ctest --test-dir "\$env:MEETING_HELPER_DIR\/build"/);
});

test("the release contract suite runs these checks", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["test:release-contracts"],
    /scripts\/pgm-meeting-stream-contract\.test\.cjs/,
  );
});
