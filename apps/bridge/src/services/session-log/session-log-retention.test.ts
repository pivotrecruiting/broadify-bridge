import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SESSION_LOG_MAX_AGE_MS,
  SESSION_LOG_MAX_FILES,
  SESSION_LOG_UPLOADED_MAX_AGE_MS,
  pruneSessionLogs,
} from "./session-log-retention.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);

describe("pruneSessionLogs", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "session-log-retention-"));
  });

  const touch = async (name: string, ageMs: number) => {
    const file = path.join(dir, name);
    await fs.writeFile(file, "{}\n");
    const at = new Date(NOW - ageMs);
    await fs.utimes(file, at, at);
  };
  const names = async () => (await fs.readdir(dir)).sort();

  it("uses the agreed limits", () => {
    expect(SESSION_LOG_MAX_AGE_MS).toBe(30 * DAY_MS);
    expect(SESSION_LOG_UPLOADED_MAX_AGE_MS).toBe(7 * DAY_MS);
    expect(SESSION_LOG_MAX_FILES).toBe(200);
  });

  it("returns 0 for a missing directory and does not create it", async () => {
    const missing = path.join(dir, "missing");
    await expect(pruneSessionLogs(missing, { now: () => NOW })).resolves.toBe(0);
    await expect(fs.access(missing)).rejects.toThrow();
  });

  it("drops un-uploaded sessions after 30 days and keeps younger ones", async () => {
    await touch("old.jsonl", 31 * DAY_MS);
    await touch("young.jsonl", 29 * DAY_MS);
    await expect(pruneSessionLogs(dir, { now: () => NOW })).resolves.toBe(1);
    expect(await names()).toEqual(["young.jsonl"]);
  });

  it("drops uploaded sessions 7 days after the marker, log and marker together", async () => {
    await touch("done.jsonl", 20 * DAY_MS);
    await touch("done.uploaded.json", 8 * DAY_MS);
    // Old recording, uploaded only recently (retry after an outage): the marker decides.
    await touch("late.jsonl", 40 * DAY_MS);
    await touch("late.uploaded.json", 2 * DAY_MS);
    await expect(pruneSessionLogs(dir, { now: () => NOW })).resolves.toBe(1);
    expect(await names()).toEqual(["late.jsonl", "late.uploaded.json"]);
  });

  it("removes an expired marker whose session file is gone", async () => {
    await touch("orphan.uploaded.json", 8 * DAY_MS);
    await touch("fresh-orphan.uploaded.json", DAY_MS);
    await pruneSessionLogs(dir, { now: () => NOW });
    expect(await names()).toEqual(["fresh-orphan.uploaded.json"]);
  });

  it("caps the number of sessions, oldest first", async () => {
    for (let i = 0; i < 6; i += 1) {
      await touch(`s${i}.jsonl`, (6 - i) * 60_000); // s0 is the oldest
    }
    await touch("s1.uploaded.json", 60_000);
    await expect(pruneSessionLogs(dir, { now: () => NOW, maxFiles: 4 })).resolves.toBe(2);
    expect(await names()).toEqual(["s2.jsonl", "s3.jsonl", "s4.jsonl", "s5.jsonl"]);
  });

  it("never touches the open session", async () => {
    await touch("open.jsonl", 90 * DAY_MS);
    await touch("closed-a.jsonl", 2 * 60_000);
    await touch("closed-b.jsonl", 60_000);
    const pruned = await pruneSessionLogs(dir, { now: () => NOW, maxFiles: 1, isSessionOpen: (id) => id === "open" });
    expect(pruned).toBe(1);
    expect(await names()).toEqual(["closed-b.jsonl", "open.jsonl"]);
  });

  it("ignores unrelated files", async () => {
    await touch("notes.txt", 400 * DAY_MS);
    await expect(pruneSessionLogs(dir, { now: () => NOW })).resolves.toBe(0);
    expect(await names()).toEqual(["notes.txt"]);
  });
});
