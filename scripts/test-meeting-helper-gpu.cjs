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
const candidates =
  process.platform === "darwin"
    ? [
        path.join(
          helperRoot,
          "Broadify Bridge Meeting Helper.app",
          "Contents",
          "MacOS",
          "BroadifyMeetingHelper",
        ),
      ]
    : process.platform === "win32"
      ? [path.join(helperRoot, "meeting-helper.exe")]
      : [path.join(helperRoot, "meeting-helper")];

const helperPath = candidates.find((candidate) => existsSync(candidate));
if (!helperPath) {
  console.error(
    "Meeting helper binary is missing. Build it before the GPU self-test.",
  );
  process.exit(2);
}

const result = spawnSync(helperPath, ["--self-test"], {
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
