import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { getBridgeContext } from "../bridge-context.js";
import { atomicWriteJson } from "../graphics/file-utils.js";
import { MEETING_RECORDING_CODECS } from "../meeting/meeting-recording-codecs.js";
import { RECORDING_FILE_EXTENSIONS } from "../shared/recording-paths.js";
import { JsonQueueStore } from "../shared/json-queue-store.js";

const RECORDING_UPLOAD_DIR = "recording-upload";
const QUEUE_FILE = "queue.json";
const SETTINGS_FILE = "settings.json";

export const RECORDING_UPLOAD_TERMINAL_STATES = ["done", "failed", "cancelled"] as const;

/**
 * One meeting recording on its way to the platform. `recording` is the
 * record of a recording that is still running (written at its start so a
 * bridge crash or shutdown cannot lose it); every other state is an upload
 * task. The upload token is deliberately not part of the record: it is
 * re-issued by the platform on every begin.
 */
export const RecordingUploadRecordSchema = z
  .object({
    /** Bridge-generated id, the platform's idempotency key (`client_recording_id`). */
    id: z.string().uuid(),
    /** Final local path of the recording; never sent anywhere, logged as basename only. */
    file_path: z.string().min(1),
    size_bytes: z.number().int().nonnegative(),
    mtime_ms: z.number().nonnegative(),
    codec: z.enum(MEETING_RECORDING_CODECS),
    container: z.enum(RECORDING_FILE_EXTENSIONS),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
    duration_ms: z.number().int().nonnegative(),
    recorded_at_ms: z.number().int().positive(),
    enqueued_at_ms: z.number().int().nonnegative(),
    state: z.enum(["recording", "queued", "hashing", "uploading", "completing", ...RECORDING_UPLOAD_TERMINAL_STATES]),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    recording_id: z.string().uuid().nullable(),
    upload_url: z.string().url().nullable(),
    bytes_uploaded: z.number().int().nonnegative(),
    /** The upload was restarted from byte 0 once after the platform rejected the object. */
    restarted: z.boolean(),
    /**
     * Uploads started again from byte 0 although the server already held bytes
     * (lost upload URL, token no longer accepted on it). Bounded, so a storage
     * that keeps discarding the upload ends the task instead of looping.
     */
    upload_restarts: z.number().int().nonnegative(),
    /** Consecutive failed attempts without byte progress. */
    attempts: z.number().int().nonnegative(),
    /**
     * Of `attempts`, those the platform or the storage answered. Only these
     * count toward the attempt limit; time without any answer (offline) is
     * bounded by the task's age alone.
     */
    answered_attempts: z.number().int().nonnegative(),
    next_attempt_at: z.number().int().nonnegative(),
    error_code: z.string().nullable(),
    updated_at_ms: z.number().int().nonnegative(),
  })
  .strict();

export type RecordingUploadRecordT = z.infer<typeof RecordingUploadRecordSchema>;

/** Persistent recording upload queue (`<userData>/recording-upload/queue.json`). */
export const recordingUploadQueueStore = new JsonQueueStore({
  dirName: RECORDING_UPLOAD_DIR,
  fileName: QUEUE_FILE,
  taskSchema: RecordingUploadRecordSchema,
  logTag: "RecordingUpload",
});

const RecordingUploadSettingsSchema = z
  .object({
    enabled: z.boolean(),
    updated_at_ms: z.number().int().nonnegative(),
  })
  .strict();

export type RecordingUploadSettingsT = z.infer<typeof RecordingUploadSettingsSchema>;

/**
 * The opt-in hint before the web app pushed anything: off. With the hint off
 * the bridge enqueues nothing and does not contact the platform (ADR-0011).
 */
export const DEFAULT_RECORDING_UPLOAD_SETTINGS: RecordingUploadSettingsT = {
  enabled: false,
  updated_at_ms: 0,
};

/**
 * The opt-in hint the web app pushed last
 * (`<userData>/recording-upload/settings.json`). It is an optimisation only:
 * the platform decides at every begin whether an upload is allowed. Anything
 * but a valid file reads as the default (off).
 */
export const recordingUploadSettingsStore = {
  async load(): Promise<RecordingUploadSettingsT> {
    try {
      const raw = await fs.readFile(settingsFilePath(), "utf8");
      const parsed = RecordingUploadSettingsSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : DEFAULT_RECORDING_UPLOAD_SETTINGS;
    } catch {
      return DEFAULT_RECORDING_UPLOAD_SETTINGS;
    }
  },

  async save(settings: RecordingUploadSettingsT): Promise<void> {
    try {
      await atomicWriteJson(settingsFilePath(), settings);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      getBridgeContext().logger.warn(`[RecordingUpload] Failed to persist the upload setting: ${message}`);
    }
  },
};

function settingsFilePath(): string {
  return path.join(getBridgeContext().userDataDir, RECORDING_UPLOAD_DIR, SETTINGS_FILE);
}
