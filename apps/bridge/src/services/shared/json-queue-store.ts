import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBridgeContext } from "../bridge-context.js";
import { atomicWriteJson } from "../graphics/file-utils.js";

export type JsonQueueStoreOptionsT<S extends z.ZodTypeAny> = {
  /** Directory below the bridge user-data dir. */
  dirName: string;
  fileName: string;
  /** Schema of one queued task; a file with any invalid task is discarded as a whole. */
  taskSchema: S;
  /** Log prefix without brackets, e.g. "Intelligence". */
  logTag: string;
};

/**
 * Persistent task queue as one JSON file (`{ tasks: [...] }`) below the
 * bridge user-data dir, written atomically. Survives bridge restarts; an
 * absent, unreadable or invalid file degrades to an empty queue instead of
 * blocking startup, and a failed write is logged, never thrown.
 */
export class JsonQueueStore<S extends z.ZodTypeAny> {
  private readonly fileSchema: z.ZodType<{ tasks: Array<z.output<S>> }>;

  constructor(private readonly options: JsonQueueStoreOptionsT<S>) {
    this.fileSchema = z.object({ tasks: z.array(options.taskSchema) }) as z.ZodType<{
      tasks: Array<z.output<S>>;
    }>;
  }

  private filePath(): string {
    return path.join(getBridgeContext().userDataDir, this.options.dirName, this.options.fileName);
  }

  async load(): Promise<Array<z.output<S>>> {
    try {
      const raw = await fs.readFile(this.filePath(), "utf8");
      const parsed = this.fileSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data.tasks : [];
    } catch {
      // Absent or unreadable file is the normal first-run case.
      return [];
    }
  }

  async save(tasks: Array<z.output<S>>): Promise<void> {
    try {
      await atomicWriteJson(this.filePath(), { tasks });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[${this.options.logTag}] Failed to persist upload queue: ${message}`,
      );
    }
  }
}
