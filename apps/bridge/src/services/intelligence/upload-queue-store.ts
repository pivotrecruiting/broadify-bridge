import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBridgeContext } from "../bridge-context.js";
import { atomicWriteJson, ensureDir } from "../graphics/file-utils.js";

const QUEUE_FILE = "upload-queue.json";
const QUEUE_DIR = "intelligence";

export const CiUploadTaskSchema = z
  .object({
    callId: z.string().min(1),
    startedAt: z.number().int().nonnegative(),
    endedAt: z.number().int().nonnegative(),
    endReason: z.string().min(1),
    attempts: z.number().int().nonnegative(),
    nextAttemptAt: z.number().int().nonnegative(),
  })
  .strict();

export type CiUploadTaskT = z.infer<typeof CiUploadTaskSchema>;

const QueueFileSchema = z.object({ tasks: z.array(CiUploadTaskSchema) });

/**
 * Persistent CI upload queue (JSON store, engine-connection-store pattern):
 * every finished call becomes one task, drained by the session coordinator
 * with backoff. Survives bridge restarts and relay outages; a corrupted file
 * degrades to an empty queue instead of blocking startup.
 */
export class CiUploadQueueStore {
  private filePath: string | null = null;

  private async resolveFilePath(): Promise<string> {
    if (this.filePath) {
      return this.filePath;
    }
    const { userDataDir } = getBridgeContext();
    const dir = path.join(userDataDir, QUEUE_DIR);
    await ensureDir(dir);
    this.filePath = path.join(dir, QUEUE_FILE);
    return this.filePath;
  }

  async load(): Promise<CiUploadTaskT[]> {
    try {
      const filePath = await this.resolveFilePath();
      const raw = await fs.readFile(filePath, "utf8");
      const parsed = QueueFileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.tasks : [];
    } catch {
      // Absent or unreadable file is the normal first-run case.
      return [];
    }
  }

  async save(tasks: CiUploadTaskT[]): Promise<void> {
    try {
      const filePath = await this.resolveFilePath();
      await atomicWriteJson(filePath, { tasks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[Intelligence] Failed to persist upload queue: ${message}`,
      );
    }
  }
}

export const ciUploadQueueStore = new CiUploadQueueStore();
