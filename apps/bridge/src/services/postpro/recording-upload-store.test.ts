import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setBridgeContext } from "../bridge-context.js";
import {
  DEFAULT_RECORDING_UPLOAD_SETTINGS,
  RecordingUploadRecordSchema,
  recordingUploadQueueStore,
  recordingUploadSettingsStore,
  type RecordingUploadRecordT,
} from "./recording-upload-store.js";

const record: RecordingUploadRecordT = {
  id: "33333333-3333-4333-8333-333333333333",
  file_path: "/Users/someone/Movies/Broadify/Broadify-Meeting-1.mp4",
  size_bytes: 1024,
  mtime_ms: 1763800000000.5,
  codec: "hevc",
  container: "mp4",
  width: 1920,
  height: 1080,
  fps: 59.94,
  duration_ms: 60_000,
  recorded_at_ms: 1763800000000,
  enqueued_at_ms: 1763800060000,
  state: "uploading",
  sha256: "a".repeat(64),
  recording_id: "22222222-2222-4222-8222-222222222222",
  upload_url: "https://project.supabase.co/storage/v1/upload/resumable/sign/abc",
  bytes_uploaded: 512,
  restarted: false,
  upload_restarts: 0,
  attempts: 2,
  answered_attempts: 0,
  next_attempt_at: 1763800090000,
  error_code: "network_error",
  updated_at_ms: 1763800061000,
};

describe("recording upload store", () => {
  let userDataDir: string;
  const dir = () => path.join(userDataDir, "recording-upload");

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-recording-upload-store-"));
    setBridgeContext({ userDataDir, logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }, logPath: path.join(userDataDir, "log.txt") });
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("the upload hint is off until the web app pushed it", async () => {
    expect(DEFAULT_RECORDING_UPLOAD_SETTINGS.enabled).toBe(false);
    expect(await recordingUploadSettingsStore.load()).toEqual({ enabled: false, updated_at_ms: 0 });
  });

  it("persists the hint in <userData>/recording-upload/settings.json", async () => {
    await recordingUploadSettingsStore.save({ enabled: true, updated_at_ms: 5 });
    expect(JSON.parse(await fs.readFile(path.join(dir(), "settings.json"), "utf8"))).toEqual({ enabled: true, updated_at_ms: 5 });
    expect(await recordingUploadSettingsStore.load()).toEqual({ enabled: true, updated_at_ms: 5 });
  });

  it.each([
    ["a corrupted file", "{ nope"],
    ["a non-boolean value", JSON.stringify({ enabled: "true", updated_at_ms: 1 })],
    ["an unknown key (e.g. a URL)", JSON.stringify({ enabled: true, updated_at_ms: 1, platform_url: "https://evil.example" })],
  ])("reads %s as off", async (_name, raw) => {
    await fs.mkdir(dir(), { recursive: true });
    await fs.writeFile(path.join(dir(), "settings.json"), raw);
    expect(await recordingUploadSettingsStore.load()).toEqual(DEFAULT_RECORDING_UPLOAD_SETTINGS);
  });

  it("persists the queue in <userData>/recording-upload/queue.json across instances", async () => {
    await recordingUploadQueueStore.save([record]);
    expect(JSON.parse(await fs.readFile(path.join(dir(), "queue.json"), "utf8"))).toEqual({ tasks: [record] });
    expect(await recordingUploadQueueStore.load()).toEqual([record]);
  });

  it("has no place for a token: unknown record keys are rejected", () => {
    expect(RecordingUploadRecordSchema.safeParse(record).success).toBe(true);
    expect(RecordingUploadRecordSchema.safeParse({ ...record, token: "signed" }).success).toBe(false);
    expect(Object.keys(RecordingUploadRecordSchema.shape)).not.toContain("token");
  });

  it("accepts every codec for a running recording and rejects malformed values", () => {
    expect(RecordingUploadRecordSchema.safeParse({ ...record, state: "recording", codec: "prores_422_hq", container: "mov" }).success).toBe(true);
    expect(RecordingUploadRecordSchema.safeParse({ ...record, codec: "av1" }).success).toBe(false);
    expect(RecordingUploadRecordSchema.safeParse({ ...record, sha256: "xyz" }).success).toBe(false);
    expect(RecordingUploadRecordSchema.safeParse({ ...record, state: "paused" }).success).toBe(false);
  });
});
