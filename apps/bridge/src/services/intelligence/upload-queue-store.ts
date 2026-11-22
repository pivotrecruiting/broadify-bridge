import { z } from "zod";
import { JsonQueueStore } from "../shared/json-queue-store.js";

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

/**
 * Persistent CI upload queue (`<userData>/intelligence/upload-queue.json`):
 * every finished call becomes one task, drained by the session coordinator
 * with backoff. Survives bridge restarts and relay outages; a corrupted file
 * degrades to an empty queue instead of blocking startup.
 */
export const ciUploadQueueStore = new JsonQueueStore({
  dirName: "intelligence",
  fileName: "upload-queue.json",
  taskSchema: CiUploadTaskSchema,
  logTag: "Intelligence",
});
