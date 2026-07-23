const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
const supportedModes = new Set(["gpu", "gpu-hardware", "keyer", "keyer-hardware"]);
if (!supportedModes.has(mode)) {
  console.error(
    "Usage: node scripts/test-meeting-helper.cjs <gpu|gpu-hardware|keyer|keyer-hardware>",
  );
  process.exit(2);
}
const testKind = mode.startsWith("gpu") ? "gpu" : "keyer";
const requireHardware = mode.endsWith("-hardware");

const helperRoot = path.resolve(
  __dirname,
  "..",
  "apps",
  "bridge",
  "native",
  "meeting-helper",
);
const helperPath =
  process.platform === "darwin"
    ? path.join(
        helperRoot,
        "Broadify Bridge Meeting Helper.app",
        "Contents",
        "MacOS",
        "BroadifyMeetingHelper",
      )
    : process.platform === "win32"
      ? path.join(helperRoot, "meeting-helper.exe")
      : path.join(helperRoot, "meeting-helper");

if (!existsSync(helperPath)) {
  console.error(
    `Meeting helper binary is missing. Build it before the ${testKind} self-test.`,
  );
  process.exit(2);
}

const args = testKind === "gpu" ? ["--self-test"] : ["--keyer-self-test"];
if (testKind === "keyer") {
  const modelsDir =
    process.env.BRIDGE_MEETING_MODELS_DIR ||
    process.env.MEETING_MODELS_DIR ||
    path.join(helperRoot, "models");
  args.push("--models-dir", modelsDir);
}

const env = { ...process.env };
if (process.platform === "win32") {
  if (requireHardware) {
    delete env.BROADIFY_MEETING_GPU_SELF_TEST_DRIVER;
    delete env.BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER;
  } else {
    env.BROADIFY_MEETING_GPU_SELF_TEST_DRIVER = "warp";
    env.BROADIFY_MEETING_KEYER_SELF_TEST_PROVIDER = "cpu";
  }
}

const result = spawnSync(helperPath, args, {
  env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
