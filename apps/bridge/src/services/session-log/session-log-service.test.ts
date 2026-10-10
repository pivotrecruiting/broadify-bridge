import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import { getSessionEventRecorder, recordSwitcherEvent, resetSessionEventRecorderForTests } from "./session-log-service.js";

describe("session-log-service", () => {
  afterEach(() => {
    resetSessionEventRecorderForTests();
  });

  it("is a no-op without bridge context", () => {
    expect(() => recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "1" })).not.toThrow();
  });

  it("writes session files under <userData>/session-log once the context exists", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-log-"));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt"), bridgeId: "bridge-1" });
    recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "1", at_ms: 1000 });
    recordSwitcherEvent({ type: "recording_started", source: "atem", at_ms: 2000 });
    recordSwitcherEvent({ type: "recording_stopped", source: "atem", at_ms: 3000 });
    const recorder = getSessionEventRecorder();
    expect(recorder).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const files = await fs.readdir(path.join(userDataDir, "session-log"));
    expect(files).toHaveLength(1);
    const lines = (await fs.readFile(path.join(userDataDir, "session-log", files[0]), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ bridge_id: "bridge-1", switcher: "atem" });
    expect(lines.slice(1).map((l) => l.type)).toEqual(["program_changed", "recording_started", "recording_stopped"]);
  });
});
