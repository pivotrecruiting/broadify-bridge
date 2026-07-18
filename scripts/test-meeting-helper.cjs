const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const mode = process.argv[2];
if (mode !== "gpu" && mode !== "keyer") {
  console.error("Usage: node scripts/test-meeting-helper.cjs <gpu|keyer>");
  process.exit(2);
}

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
    `Meeting helper binary is missing. Build it before the ${mode} self-test.`,
  );
  process.exit(2);
}

const args = mode === "gpu" ? ["--self-test"] : ["--keyer-self-test"];
if (mode === "keyer") {
  const modelsDir =
    process.env.BRIDGE_MEETING_MODELS_DIR ||
    process.env.MEETING_MODELS_DIR ||
    path.join(helperRoot, "models");
  args.push("--models-dir", modelsDir);
}

const result = spawnSync(helperPath, args, {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
