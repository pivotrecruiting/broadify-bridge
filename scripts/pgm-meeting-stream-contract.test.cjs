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

// CMake and YAML: a comment runs from `#` to the end of the line.
function stripHashComments(source) {
  return source.replace(/#.*$/gm, "");
}

// The text of one job of a workflow, from its key to the next job or the end of the file.
function workflowJob(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} must exist`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
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
  // The helper never turns a part of the live program on by itself, in whatever
  // spelling: set(), set (... CACHE ...), option(), a read of the environment.
  // Only its comments name the switches.
  const cmakeCode = stripHashComments(cmake);
  assert.doesNotMatch(cmakeCode, /LIVE_STREAM_WITH_/);
  assert.doesNotMatch(cmakeCode, /BROADIFY_PGM_WINDOWS/);
  assert.doesNotMatch(cmakeCode, /FetchContent/i);
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
  assert.match(
    windows[1],
    /target_link_libraries\(meeting-helper PRIVATE live_stream program_stream_encoder_info\)/,
  );
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

test("the picked encoder is reported through the PGM helper's module, only where the stream is built", () => {
  // One implementation for both helpers: the meeting helper compiles the PGM
  // helper's source from where it lives and carries no copy of it.
  const library = cmake.match(
    /\nif\(TARGET live_stream\)\n([\s\S]*?)\nendif\(\)\n(?=\nif\(APPLE\)\n  # Program stream:)/,
  );
  assert.ok(library, "the encoder info library must sit behind the live_stream target");
  assert.match(
    library[1],
    /\n  add_library\(program_stream_encoder_info STATIC \.\.\/pgm-helper\/src\/common\/encoder_info_json\.cpp\)\n/,
  );
  assert.equal((cmake.match(/encoder_info_json/g) || []).length, 1);
  assert.ok(fs.existsSync(path.join(root, "apps/bridge/native/pgm-helper/src/common/encoder_info_json.cpp")));
  // Its users get the PGM helper's `common` directory and nothing else of that
  // tree: with the tree root on their include path, a header both helpers have
  // (macos/macos_app.h) could resolve to the wrong one. Only the module's own
  // source is compiled with the root.
  assert.match(
    library[1],
    /\n  target_include_directories\(program_stream_encoder_info\n    PUBLIC \.\.\/pgm-helper\/src\/common\n    PRIVATE \.\.\/pgm-helper\/src\n  \)\n/,
  );
  assert.equal(
    (cmake.match(/pgm-helper\/src/g) || []).length,
    3,
    "the module's source and its two include directories are the only paths into the PGM helper",
  );
  const workerSource = read(`${LIVE}/program_stream.cpp`);
  assert.match(workerSource, /\n#include "encoder_info_json\.h"/);
  assert.doesNotMatch(workerSource, /#include "common\/encoder_/);
  for (const dir of [LIVE, `${MEETING_HELPER}/src/common`]) {
    const copies = fs.readdirSync(path.join(root, dir)).filter((name) => /encoder_info/.test(name));
    assert.deepEqual(copies, [], `${dir} must not carry its own encoder info module`);
  }
  // Nothing outside the branches that build the real stream, and its tests, links it.
  const tests = cmake.match(/\n  if\(TARGET live_stream\)\n[\s\S]*?\n  endif\(\)\nendif\(\)\n$/);
  assert.ok(tests);
  const block = programStreamBlock();
  const outside = cmake.replace(library[0], "").replace(block, "").replace(tests[0], "");
  assert.doesNotMatch(outside, /program_stream_encoder_info/);
  assert.doesNotMatch(block.slice(block.lastIndexOf("\nelse()\n")), /program_stream_encoder_info/);

  // The worker names the encoder in the event and in the status, both through the module.
  const worker = stripComments(read(`${LIVE}/program_stream.cpp`));
  assert.equal((worker.match(/pgm::encoderDetailJsonMembers\(info\)/g) || []).length, 2);
});

test("failed encoder set-ups are paced by the PGM helper's back-off, not by a rule of the worker's own", () => {
  const workerSource = read(`${LIVE}/program_stream.cpp`);
  assert.match(workerSource, /\n#include "encoder_retry_backoff\.h"/);
  assert.ok(fs.existsSync(path.join(root, "apps/bridge/native/pgm-helper/src/common/encoder_retry_backoff.h")));
  assert.deepEqual(
    fs.readdirSync(path.join(root, LIVE)).filter((name) => /backoff/i.test(name)),
    [],
    "the meeting helper must not carry its own back-off",
  );
  // The failed target waits, both failure exits report to the back-off, and
  // a set-up that works clears it: a target that returns after another one
  // was set up is tried at once.
  const worker = stripComments(workerSource);
  assert.match(worker, /\n  pgm::EncoderRetryBackoff encoderRetry;\n/);
  assert.match(
    worker,
    /converter->pacesEncoderRetries\(\) && !encoderRetry\.attemptDue\(wanted, live::monotonicNowNs\(\)\)/,
  );
  assert.equal((worker.match(/encoderRetry\.onFailure\(wanted, live::monotonicNowNs\(\)\);/g) || []).length, 2);
  assert.match(worker, /\n    encoderConfigured = true;\n    encoderRetry\.reset\(\);\n/);
  // No second clock next to it.
  assert.doesNotMatch(worker, /steady_clock::time_point [a-zA-Z]*[rR]etry/);
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

test("no npm script switches the live program on, and release.yml never does", () => {
  // Neither the build switch nor one of the partial ones live-stream reads
  // from the environment (LIVE_STREAM_WITH_MF=1 in dist:win would compile the
  // encoder into every release), nor extra configure arguments.
  const partialSwitches = /LIVE_STREAM_WITH_|MEETING_HELPER_CMAKE_EXTRA_ARGS/;
  const packageJson = JSON.parse(read("package.json"));
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.ok(
      !/BROADIFY_PGM_WINDOWS/.test(command) && !partialSwitches.test(command),
      `npm script ${name} must not switch a part of the live program on`,
    );
  }
  assert.doesNotMatch(read("scripts/build-meeting-helper.sh"), /BROADIFY_PGM_WINDOWS|LIVE_STREAM/);
  // release.yml builds what customers install. For the build switch itself,
  // test-release.yml is left to the release contract of the packaging unit: a
  // throw-away opt-in build for a device session may set it there, for a
  // whole job. The partial switches have no place in either workflow.
  assert.doesNotMatch(
    read(".github/workflows/release.yml"),
    /BROADIFY_PGM_WINDOWS\s*[:=]\s*["']?1/,
    "release.yml must not set the build switch",
  );
  for (const workflow of ["release.yml", "test-release.yml"]) {
    assert.doesNotMatch(read(`.github/workflows/${workflow}`), partialSwitches, workflow);
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
  assert.match(converter, /bool pacesEncoderRetries\(\) const override \{ return true; \}/);

  // macOS keeps today's hand-over: under the store lock, a new encoder attempt with every frame.
  const vt = stripComments(read(`${LIVE}/program_frame_converter_vt.mm`));
  assert.match(vt, /bool runsUnderStoreLock\(\) const override \{ return true; \}/);
  assert.match(vt, /bool pacesEncoderRetries\(\) const override \{ return false; \}/);
});

test("the Windows workflow builds and tests the meeting helper in both configurations", () => {
  const workflow = read(".github/workflows/pgm-windows-native.yml");
  // Pushes that touch the helper trigger the workflow.
  assert.match(workflow, /\n {6}- apps\/bridge\/native\/meeting-helper\/\*\*\n/);
  const body = workflowJob(workflow, "meeting");
  // Nothing in the job may fail without failing it: not a step, not a leg.
  assert.doesNotMatch(stripHashComments(body), /continue-on-error/);
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
  // Built serially, as a release: the parallel level this workflow sets for
  // its other jobs is taken out of the environment before the npm command.
  for (const step of [build, buildAllAndTest]) {
    const removal = step.indexOf("Remove-Item Env:CMAKE_BUILD_PARALLEL_LEVEL");
    assert.ok(
      removal >= 0 && removal < step.indexOf("npm run "),
      "the parallel build level must be removed before the build",
    );
    assert.match(step, /if \(Test-Path Env:CMAKE_BUILD_PARALLEL_LEVEL\) \{ throw /);
    assert.doesNotMatch(step, /--parallel|\/m\b|-j\d/);
  }
  // A leg that had to build without OpenVINO is not the release configuration:
  // the job summary says so and the last step of the job, which runs for both
  // legs, fails it.
  assert.match(
    body,
    /built WITHOUT the OpenVINO backend[\s\S]*?Out-File -FilePath \$env:GITHUB_STEP_SUMMARY/,
  );
  const last = steps[steps.length - 1];
  assert.match(last, /^Matting backends as in a release \(OpenVINO was built\)\n/);
  assert.doesNotMatch(last, /\n {8}if:/);
  assert.match(last, /if \(\$env:MEETING_HELPER_ENABLE_OPENVINO -ne '1'\) \{\n\s+throw /);
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
