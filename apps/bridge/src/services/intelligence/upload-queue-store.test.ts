import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import { JsonQueueStore } from "../shared/json-queue-store.js";
import { CiUploadTaskSchema, ciUploadQueueStore, type CiUploadTaskT } from "./upload-queue-store.js";

describe("ciUploadQueueStore", () => {
  it("keeps its file location and format (<userData>/intelligence/upload-queue.json)", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-ci-queue-"));
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
    setBridgeContext({ userDataDir, logger, logPath: path.join(userDataDir, "log.txt") });
    const task: CiUploadTaskT = { callId: "call-1", startedAt: 1, endedAt: 2, endReason: "ended", attempts: 0, nextAttemptAt: 3 };

    expect(ciUploadQueueStore).toBeInstanceOf(JsonQueueStore);
    await ciUploadQueueStore.save([task]);
    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, "intelligence", "upload-queue.json"), "utf8"));
    expect(raw).toEqual({ tasks: [task] });
    expect(await ciUploadQueueStore.load()).toEqual([task]);
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("rejects unknown task keys", () => {
    expect(
      CiUploadTaskSchema.safeParse({ callId: "c", startedAt: 1, endedAt: 2, endReason: "x", attempts: 0, nextAttemptAt: 0, url: "https://x" }).success,
    ).toBe(false);
  });
});
