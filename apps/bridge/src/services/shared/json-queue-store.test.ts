import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { setBridgeContext } from "../bridge-context.js";
import { JsonQueueStore } from "./json-queue-store.js";

const TaskSchema = z.object({ id: z.string().min(1), attempts: z.number().int().nonnegative() }).strict();

describe("JsonQueueStore", () => {
  let userDataDir: string;
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const createStore = () =>
    new JsonQueueStore({ dirName: "queue-test", fileName: "queue.json", taskSchema: TaskSchema, logTag: "QueueTest" });

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-json-queue-"));
    logger.warn.mockClear();
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt") });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("is empty before the first save", async () => {
    expect(await createStore().load()).toEqual([]);
  });

  it("persists tasks so a new instance (bridge restart) reads them back", async () => {
    const tasks = [{ id: "a", attempts: 0 }, { id: "b", attempts: 3 }];
    await createStore().save(tasks);
    expect(await createStore().load()).toEqual(tasks);
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, "queue-test", "queue.json"), "utf8"));
    expect(raw).toEqual({ tasks });
    // Atomic write: no temp file is left behind.
    expect(await fs.readdir(path.join(userDataDir, "queue-test"))).toEqual(["queue.json"]);
  });

  it("degrades to an empty queue on a corrupted file", async () => {
    const dir = path.join(userDataDir, "queue-test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "queue.json"), "{ not json");
    expect(await createStore().load()).toEqual([]);
    // Lost tasks are never silent, and the log line carries no file content.
    expect(logger.warn.mock.calls).toEqual([
      ["[QueueTest] Discarding the persisted upload queue (invalid JSON); starting with an empty queue"],
    ]);
  });

  it("does not log on the first run, when there is no file yet", async () => {
    await createStore().load();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("serialises overlapping writes: the file is always valid and ends with the last save", async () => {
    const store = createStore();
    const filePath = path.join(userDataDir, "queue-test", "queue.json");
    for (let round = 0; round < 50; round += 1) {
      // Different sizes: an interleaved write would leave a mix of both documents.
      const large = Array.from({ length: 400 }, (_unused, index) => ({ id: `large-${round}-${index}`, attempts: index }));
      const small = [{ id: `small-${round}`, attempts: round }];
      await Promise.all([store.save(large), store.save(small)]);
      expect(JSON.parse(await fs.readFile(filePath, "utf8"))).toEqual({ tasks: small });
    }
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await fs.readdir(path.join(userDataDir, "queue-test"))).toEqual(["queue.json"]);
  });

  it("writes the tasks as they were when save was called", async () => {
    const store = createStore();
    const tasks = [{ id: "a", attempts: 0 }];
    const first = store.save(tasks);
    tasks[0].attempts = 9;
    await first;
    expect(await createStore().load()).toEqual([{ id: "a", attempts: 0 }]);
  });

  it("discards a file with a task that does not match the schema", async () => {
    const dir = path.join(userDataDir, "queue-test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "queue.json"),
      JSON.stringify({ tasks: [{ id: "a", attempts: 0 }, { id: "b", attempts: 0, extra: true }] }),
    );
    expect(await createStore().load()).toEqual([]);
    expect(String(logger.warn.mock.calls[0][0])).toContain("(invalid tasks)");
  });

  it("logs a failed write with its tag instead of throwing", async () => {
    const store = createStore();
    // A directory in place of the queue file makes the atomic rename fail.
    await fs.mkdir(path.join(userDataDir, "queue-test", "queue.json"), { recursive: true });
    await expect(store.save([{ id: "a", attempts: 0 }])).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/^\[QueueTest\] Failed to persist upload queue: /);
  });
});
