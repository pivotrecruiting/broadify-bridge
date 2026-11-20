import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";
import { diffAtemState, type AtemStateLikeT } from "./atem-state-diff.js";
import { SessionEventRecorder } from "./session-event-recorder.js";

// Jest runs from the repo root (ts-jest compiles to CJS, no import.meta).
const here = path.join(process.cwd(), "apps", "bridge", "src", "services", "session-log");

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "session-log-"));
}

describe("SessionEventRecorder", () => {
  test("ignores events outside a session and snapshots on-air state at start", async () => {
    let now = 1000;
    const rec = new SessionEventRecorder({ dir: await tmpDir(), now: () => now, newSessionId: () => "s1", bridgeId: "b1" });
    rec.record({ type: "program_changed", source: "atem", me: 0, input_id: "3" });
    rec.record({ type: "keyer_on_air", source: "atem", keyer: "dsk1" });
    expect(rec.currentSessionId).toBeNull();
    now = 2000;
    rec.record({ type: "recording_started", source: "atem" });
    now = 3000;
    rec.record({ type: "keyer_off_air", source: "atem", keyer: "dsk1" });
    rec.record({ type: "recording_stopped", source: "atem" });
    expect(rec.currentSessionId).toBeNull();
    const session = await rec.readSession("s1");
    expect(session?.header).toMatchObject({ session_id: "s1", bridge_id: "b1", started_at_ms: 2000, switcher: "atem", schema_version: "1.0.0" });
    expect(session?.events.map((e) => [e.type, e.at_ms])).toEqual([
      ["program_changed", 2000],
      ["keyer_on_air", 2000],
      ["recording_started", 2000],
      ["keyer_off_air", 3000],
      ["recording_stopped", 3000],
    ]);
  });

  test("drops invalid events without throwing", async () => {
    const rec = new SessionEventRecorder({ dir: await tmpDir(), newSessionId: () => "s2" });
    rec.startSession("vmix");
    expect(() => rec.record({ type: "nope" as never, source: "vmix" })).not.toThrow();
    const session = await rec.readSession("s2");
    expect(session?.events).toEqual([]);
  });

  test("ATEM replay fixture produces the expected session", async () => {
    const fixture = JSON.parse(readFileSync(path.join(here, "fixtures", "atem-replay-basic.json"), "utf8")) as {
      steps: Array<{ at_ms: number; state: AtemStateLikeT }>;
      expected_session_types: string[];
    };
    const rec = new SessionEventRecorder({ dir: await tmpDir(), newSessionId: () => "replay" });
    let prev: AtemStateLikeT | undefined;
    for (const step of fixture.steps) {
      for (const event of diffAtemState(prev, step.state)) {
        rec.record({ ...event, at_ms: step.at_ms });
      }
      prev = step.state;
    }
    const session = await rec.readSession("replay");
    expect(session?.events.map((e) => e.type)).toEqual(fixture.expected_session_types);
    expect(session?.events.at(-1)).toMatchObject({ type: "recording_stopped", timecode: "00:00:18:12" });
  });
});
