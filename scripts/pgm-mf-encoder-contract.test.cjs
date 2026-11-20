const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
// Line endings normalized: a Windows checkout may hand out CRLF.
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");

// ADR-0009: the Windows live program encodes with a hardware H.264 encoder MFT
// or not at all (`encoder_unavailable`). Microsoft's software encoder MFT is a
// test tool: it may only appear in the live-stream test binaries, where it is
// injected through the encoder's test seam. These checks keep that true at the
// source level, on every platform, before anything is compiled on Windows.
const LIVE_STREAM = "apps/bridge/native/live-stream";
const ENCODER = `${LIVE_STREAM}/src/mf_encoder.cpp`;
const SEAM_HEADER = "mf_encoder_internal.h";
const SEAM_FACTORY = "createMediaFoundationEncoder";

// CLSID_CMSH264EncoderMFT, by name (any spelling) and by value.
const SOFTWARE_ENCODER_PATTERNS = [
  /CLSID_C?MSH264EncoderMFT/i,
  /CMSH264EncoderMFT/i,
  /6ca50344/i,
  /0x051a\s*,\s*0x4ded/i,
];

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function listFiles(relativeDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), {
      withFileTypes: true,
    })) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === "build" || entry.name.startsWith("build-")) continue;
        walk(child);
      } else if (/\.(c|cc|cpp|h|hpp|mm|m)$/.test(entry.name)) {
        out.push(child);
      }
    }
  };
  walk(relativeDir);
  return out;
}

test("the Media Foundation encoder source contains no software encoder MFT", () => {
  for (const file of [
    ENCODER,
    `${LIVE_STREAM}/src/${SEAM_HEADER}`,
    `${LIVE_STREAM}/src/mf_encoder_policy.cpp`,
    `${LIVE_STREAM}/include/live_stream/mf_encoder_policy.h`,
  ]) {
    const source = read(file);
    for (const pattern of SOFTWARE_ENCODER_PATTERNS) {
      assert.doesNotMatch(
        source,
        pattern,
        `${file} must not reference the Microsoft software H.264 encoder MFT`,
      );
    }
    assert.doesNotMatch(
      source,
      /CoCreateInstance/,
      `${file} must not create an encoder by class id; encoders come from the hardware enumeration`,
    );
  }
});

test("the encoder only ever enumerates hardware encoder MFTs", () => {
  const source = stripComments(read(ENCODER));
  const calls = [...source.matchAll(/\bMFTEnum(Ex|2)?\s*\(([\s\S]*?)\)\s*;/g)];
  assert.equal(calls.length, 1, "exactly one MFT enumeration is expected");
  const [, variant, args] = calls[0];
  assert.equal(variant, "Ex", "the enumeration must be MFTEnumEx");
  assert.match(args, /MFT_CATEGORY_VIDEO_ENCODER/);
  assert.match(args, /MFT_ENUM_FLAG_HARDWARE/);
  for (const flag of [
    "MFT_ENUM_FLAG_SYNCMFT",
    "MFT_ENUM_FLAG_ASYNCMFT",
    "MFT_ENUM_FLAG_ALL",
    "MFT_ENUM_FLAG_TRANSCODE_ONLY",
  ]) {
    assert.ok(
      !source.includes(flag),
      `${flag} would let a software encoder MFT into the candidate list`,
    );
  }
  // A transform that is not asynchronous is not a hardware encoder: refused.
  assert.match(source, /MF_TRANSFORM_ASYNC\b/);
  assert.match(source, /"async_required"/);
});

test("the production factory uses the hardware enumeration and reports encoder_unavailable", () => {
  const source = stripComments(read(ENCODER));
  const factory = source.match(
    /std::unique_ptr<VideoEncoder>\s+createHardwareEncoder\s*\(\s*\)\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(factory, "createHardwareEncoder must be defined in mf_encoder.cpp");
  assert.match(factory[1], /&enumerateHardwareH264Encoders\b/);
  assert.match(source, /errorCode = "encoder_unavailable"/);
});

test("the software encoder MFT appears only in live-stream test sources", () => {
  const offenders = [];
  for (const file of listFiles("apps/bridge/native")) {
    if (file.startsWith(`${LIVE_STREAM}/tests/`)) continue;
    // Third-party trees fetched or vendored into a helper are not ours to police.
    if (/\/(third_party|vendor|_deps|node_modules)\//.test(file)) continue;
    const source = read(file);
    if (SOFTWARE_ENCODER_PATTERNS.some((pattern) => pattern.test(source))) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the encoder test seam is used by live-stream tests only", () => {
  const offenders = [];
  for (const file of listFiles("apps/bridge/native")) {
    if (file.startsWith(`${LIVE_STREAM}/tests/`)) continue;
    if (file === ENCODER || file === `${LIVE_STREAM}/src/${SEAM_HEADER}`) continue;
    if (/\/(third_party|vendor|_deps|node_modules)\//.test(file)) continue;
    const source = read(file);
    if (source.includes(SEAM_HEADER) || source.includes(SEAM_FACTORY)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "helpers must create the encoder through createHardwareEncoder()",
  );
});

test("the encoder builds its input from the frame's CPU planes only", () => {
  // A capturer's sample behind CapturedFrame::nativeHandle is borrowed for one
  // call, while an MFT keeps its input until it has encoded it. The encoder
  // copies the planes into its own pooled sample and never wraps or forwards
  // the borrowed one.
  const source = stripComments(read(ENCODER));
  assert.doesNotMatch(source, /nativeHandle/);
  assert.match(
    source,
    /frameToNv12\(frame, planes, plan_\.width, plan_\.height, scratch_\)/,
  );
});

test("the Media Foundation targets are opt-in and the seam test stays a test", () => {
  const cmake = read(`${LIVE_STREAM}/CMakeLists.txt`);
  // Default OFF: only an explicit option, LIVE_STREAM_WITH_MF or the build
  // switch BROADIFY_PGM_WINDOWS=1 turns the Windows targets on.
  const option = cmake.match(
    /if\(NOT DEFINED LIVE_STREAM_WITH_MF\)([\s\S]*?)\nendif\(\)/,
  );
  assert.ok(option, "LIVE_STREAM_WITH_MF default block must exist");
  assert.match(option[1], /ENV\{BROADIFY_PGM_WINDOWS\}" STREQUAL "1"/);
  assert.match(option[1], /else\(\)\s*\n\s*set\(LIVE_STREAM_WITH_MF OFF\)/);
  assert.equal(
    (option[1].match(/set\(LIVE_STREAM_WITH_MF ON\)/g) || []).length,
    1,
    "only the build switch may default the encoder to ON",
  );

  const gated = cmake.match(
    /if\(LIVE_STREAM_WITH_MF AND WIN32\)([\s\S]*?)\nendif\(\)\n\nif\(LIVE_STREAM_BUILD_TESTS\)/,
  );
  assert.ok(gated, "Media Foundation targets must sit inside the opt-in block");
  for (const name of [
    "src/mf_encoder.cpp",
    "mf_encoder_fake_mft_test",
    "mf_encoder_software_seam_test",
    "mf_encoder_smoke_test",
  ]) {
    assert.ok(gated[1].includes(name), `${name} must be gated`);
    assert.ok(
      !cmake.replace(gated[0], "").includes(name),
      `${name} must not be referenced outside the opt-in block`,
    );
  }
  // The software seam source builds exactly one executable and no library.
  assert.match(
    gated[1],
    /add_executable\(mf_encoder_software_seam_test tests\/mf_encoder_software_seam_test\.cpp\)/,
  );
  assert.equal(
    (cmake.match(/mf_encoder_software_seam_test\.cpp/g) || []).length,
    1,
  );
  // Both skipping tests report "skipped", not "passed", when they cannot run.
  for (const name of ["mf_encoder_software_seam_test", "mf_encoder_smoke_test"]) {
    assert.match(
      gated[1],
      new RegExp(
        `set_tests_properties\\(${name} PROPERTIES SKIP_RETURN_CODE 77`,
      ),
    );
  }
});

test("the release contract suite runs these checks", () => {
  const packageJson = JSON.parse(read("package.json"));
  assert.match(
    packageJson.scripts["test:release-contracts"],
    /scripts\/pgm-mf-encoder-contract\.test\.cjs/,
  );
});
