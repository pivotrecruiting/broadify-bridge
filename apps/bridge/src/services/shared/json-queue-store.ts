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
 * blocking startup (an existing file that cannot be used is logged), and a
 * failed write is logged, never thrown. Writes of one store run one after
 * the other: the atomic write uses one temp file per queue file, so two
 * overlapping writes would corrupt it.
 */
export class JsonQueueStore<S extends z.ZodTypeAny> {
  private readonly fileSchema: z.ZodType<{ tasks: Array<z.output<S>> }>;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: JsonQueueStoreOptionsT<S>) {
    this.fileSchema = z.object({ tasks: z.array(options.taskSchema) }) as z.ZodType<{
      tasks: Array<z.output<S>>;
    }>;
  }

  private filePath(): string {
    return path.join(getBridgeContext().userDataDir, this.options.dirName, this.options.fileName);
  }

  async load(): Promise<Array<z.output<S>>> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath(), "utf8");
    } catch (error) {
      // An absent file is the normal first-run case.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.warnDiscarded("unreadable");
      }
      return [];
    }
    try {
      const parsed = this.fileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        return parsed.data.tasks;
      }
      this.warnDiscarded("invalid tasks");
    } catch {
      this.warnDiscarded("invalid JSON");
    }
    return [];
  }

  /**
   * Writes the queue. Resolves when this write is on disk (or was logged as
   * failed); a write requested while another one runs waits for it.
   */
  save(tasks: Array<z.output<S>>): Promise<void> {
    // Serialized now: the caller may keep changing its tasks while earlier writes run.
    const snapshot = { tasks: structuredClone(tasks) };
    this.writeChain = this.writeChain.then(() => this.write(snapshot));
    return this.writeChain;
  }

  private async write(snapshot: { tasks: Array<z.output<S>> }): Promise<void> {
    try {
      await atomicWriteJson(this.filePath(), snapshot);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(
        `[${this.options.logTag}] Failed to persist upload queue: ${message}`,
      );
    }
  }

  /** Fixed text and the kind of defect only: never file content or the path. */
  private warnDiscarded(reason: string): void {
    getBridgeContext().logger.warn(
      `[${this.options.logTag}] Discarding the persisted upload queue (${reason}); starting with an empty queue`,
    );
  }
}
