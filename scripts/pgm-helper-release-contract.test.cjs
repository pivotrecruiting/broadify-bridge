const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");
const packageJson = JSON.parse(read("package.json"));

// Both native recorders (meeting + PGM) bound their blocking finalize step
// with one shared constant in helper-common. Every client-side timeout that
// waits on that finalize must stay above it: a client timeout does not cancel
// the helper-side work, so a larger helper bound would make the bridge report
// failure while the helper still finalizes (invisible background recording).
const SHARED_POLICY_HEADER =
  "apps/bridge/native/helper-common/include/helper_common/recording_encode_policy.h";

function readFinalizeTimeoutMs() {
  const policy = read(SHARED_POLICY_HEADER);
  const match = policy.match(
    /constexpr int kRecorderFinalizeTimeoutMs = ([0-9']+);/,
  );
  assert.ok(match, "kRecorderFinalizeTimeoutMs must be defined in helper-common");
  const value = Number(match[1].replace(/'/g, ""));
  assert.ok(Number.isFinite(value) && value > 0);
  return value;
}

test("native CTest for the PGM helper always selects the Release configuration", () => {
  const script = packageJson.scripts["test:pgm-helper-native"];
  assert.match(script, /cmake --build .* --config Release/);
  assert.match(script, /ctest .* --build-config Release/);
});

test("shared recorder finalize timeout stays below the meeting recording.stop RPC timeout", () => {
  const finalizeTimeoutMs = readFinalizeTimeoutMs();
  const timeouts = read(
    "apps/bridge/src/services/meeting/meeting-helper-timeouts.ts",
  );
  const stopMatch = timeouts.match(/"recording\.stop": ([0-9_]+),/);
  assert.ok(stopMatch, "recording.stop RPC timeout must be defined");
  const stopTimeoutMs = Number(stopMatch[1].replace(/_/g, ""));
  assert.ok(
    finalizeTimeoutMs < stopTimeoutMs,
    `finalize timeout ${finalizeTimeoutMs} ms must be below recording.stop ${stopTimeoutMs} ms`,
  );
});

test("shared recorder finalize timeout stays below the PGM recording stop RPC timeout and its relay SLA", () => {
  const finalizeTimeoutMs = readFinalizeTimeoutMs();

  const client = read("apps/bridge/src/services/pgm/pgm-helper-client.ts");
  const stopMatch = client.match(/"pgm\.recording\.stop": ([0-9_]+),/);
  assert.ok(stopMatch, "pgm.recording.stop RPC timeout must be defined");
  const stopTimeoutMs = Number(stopMatch[1].replace(/_/g, ""));
  assert.ok(
    finalizeTimeoutMs < stopTimeoutMs,
    `finalize timeout ${finalizeTimeoutMs} ms must be below pgm.recording.stop ${stopTimeoutMs} ms`,
  );

  // Relay policy: sideEffect("pgm_recording_stop", <class>, <relay timeout>, <bridge-local SLA>, ...)
  const policy = read("apps/bridge/src/services/relay-command-policy.ts");
  const slaMatch = policy.match(
    /sideEffect\("pgm_recording_stop", "[a-z_]+", ([0-9_]+), ([0-9_]+),/,
  );
  assert.ok(slaMatch, "pgm_recording_stop relay policy must be defined");
  const relayTimeoutMs = Number(slaMatch[1].replace(/_/g, ""));
  const localSlaMs = Number(slaMatch[2].replace(/_/g, ""));
  assert.ok(
    stopTimeoutMs < localSlaMs,
    `pgm.recording.stop ${stopTimeoutMs} ms must be below the bridge-local SLA ${localSlaMs} ms`,
  );
  assert.ok(
    localSlaMs < relayTimeoutMs,
    `bridge-local SLA ${localSlaMs} ms must be below the relay timeout ${relayTimeoutMs} ms`,
  );
});

test("PGM MP4 recorder waits on the shared finalize constant, not a literal", () => {
  const recorder = read(
    "apps/bridge/native/pgm-helper/src/recorder/mp4_recorder.mm",
  );
  assert.ok(
    recorder.includes("kRecorderFinalizeTimeoutMs"),
    "mp4_recorder.mm must wait on kRecorderFinalizeTimeoutMs",
  );
  assert.doesNotMatch(
    recorder,
    /15 \* NSEC_PER_SEC/,
    "mp4_recorder.mm must not carry its own finalize literal",
  );
});
