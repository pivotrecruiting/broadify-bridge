import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import {
  getSessionEventRecorder,
  initializeSessionLog,
  isSessionLogEnabled,
  recordSwitcherEvent,
  resetSessionEventRecorderForTests,
} from "./session-log-service.js";

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
    // No bridge id: recording only, no uploader (no network in this test).
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt"), postproApiUrl: "https://postpro.example/base?token=secret" });
    recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "1", at_ms: 1000 });
    recordSwitcherEvent({ type: "recording_started", source: "atem", at_ms: 2000 });
    recordSwitcherEvent({ type: "recording_stopped", source: "atem", at_ms: 3000 });
    const recorder = getSessionEventRecorder();
    expect(recorder).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const files = await fs.readdir(path.join(userDataDir, "session-log"));
    expect(files).toHaveLength(1);
    const lines = (await fs.readFile(path.join(userDataDir, "session-log", files[0]), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ bridge_id: null, switcher: "atem" });
    expect(lines.slice(1).map((l) => l.type)).toEqual(["program_changed", "recording_started", "recording_stopped"]);
  });

  it("logs one startup line without the URL and one hint when the bridge id is missing", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-log-"));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt"), postproApiUrl: "https://postpro.example/base?token=secret" });
    expect(isSessionLogEnabled()).toBe(true);
    initializeSessionLog();
    recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "1" });
    recordSwitcherEvent({ type: "program_changed", source: "atem", me: 0, input_id: "2" });
    expect(logger.info.mock.calls).toEqual([["[SessionLog] enabled"]]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toContain("postpro.example");
    expect(logged).not.toContain("secret");
    // Enabling alone creates nothing on disk; the directory appears with the first session.
    await expect(fs.access(path.join(userDataDir, "session-log"))).rejects.toThrow();
  });

  it("prunes expired session logs on init when enabled, and leaves them alone when disabled", async () => {
    const makeDir = async () => {
      const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-log-"));
      const dir = path.join(userDataDir, "session-log");
      await fs.mkdir(dir);
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await fs.writeFile(path.join(dir, "old.jsonl"), "{}\n");
      await fs.utimes(path.join(dir, "old.jsonl"), old, old);
      await fs.writeFile(path.join(dir, "new.jsonl"), "{}\n");
      return { userDataDir, dir };
    };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

    const off = await makeDir();
    setBridgeContext({ userDataDir: off.userDataDir, logger, logPath: path.join(off.userDataDir, "log.txt") });
    initializeSessionLog();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await fs.readdir(off.dir)).sort()).toEqual(["new.jsonl", "old.jsonl"]);

    resetSessionEventRecorderForTests();
    const on = await makeDir();
    setBridgeContext({ userDataDir: on.userDataDir, logger, logPath: path.join(on.userDataDir, "log.txt"), postproApiUrl: "https://postpro.example" });
    initializeSessionLog();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await fs.readdir(on.dir)).toEqual(["new.jsonl"]);
  });
});
