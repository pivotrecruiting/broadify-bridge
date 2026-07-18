const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const helperRoot = path.join(
  root,
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
    "Meeting helper binary is missing. Build it before the keyer self-test.",
  );
  process.exit(2);
}
const modelsDir =
  process.env.BRIDGE_MEETING_MODELS_DIR ||
  process.env.MEETING_MODELS_DIR ||
  path.join(helperRoot, "models");
const result = spawnSync(
  helperPath,
  ["--keyer-self-test", "--models-dir", modelsDir],
  { env: process.env, stdio: "inherit" },
);
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
