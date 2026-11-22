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
  });

  it("discards a file with a task that does not match the schema", async () => {
    const dir = path.join(userDataDir, "queue-test");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "queue.json"),
      JSON.stringify({ tasks: [{ id: "a", attempts: 0 }, { id: "b", attempts: 0, extra: true }] }),
    );
    expect(await createStore().load()).toEqual([]);
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
