import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MeetingRecordingUploadStatusT } from "@broadify/protocol";
import { PlatformRequestError } from "./platform-client.js";
import type {
  RecordingUploadBeginRequestT,
  RecordingUploadGrantT,
  RecordingUploadPlatformT,
} from "./recording-upload-platform.js";
import type { RecordingUploadRecordT, RecordingUploadSettingsT } from "./recording-upload-store.js";
import { RecordingUploader } from "./recording-uploader.js";
import { TUS_SIGNED_ENDPOINT_PATH, TusHttpError, type TusPatchOptionsT, type TusTransportT } from "./tus-upload-client.js";

const ENDPOINT = `https://project.supabase.co${TUS_SIGNED_ENDPOINT_PATH}`;
const UPLOAD_URL = `${ENDPOINT}/upload-1`;
const RECORDING_ID = "22222222-2222-4222-8222-222222222222";
const CHUNK = 1000;
const PROGRAM_FORMAT = { width: 1920, height: 1080, fps: 30 };
const DAY_MS = 24 * 60 * 60_000;

const platformError = (status: number, code: string | null) =>
  new PlatformRequestError("/api/postpro/bridge/recordings/begin", status, code, "detail");

describe("RecordingUploader", () => {
  let dir: string;
  let clock: number;
  let records: RecordingUploadRecordT[];
  let settings: RecordingUploadSettingsT;
  let published: MeetingRecordingUploadStatusT[];
  let logger: { info: jest.Mock; warn: jest.Mock };
  let begins: RecordingUploadBeginRequestT[];
  let completes: Array<{ recording_id: string; size_bytes: number; sha256: string }>;
  let aborts: Array<{ recording_id: string; error_code: string }>;
  let beginAnswers: Array<RecordingUploadGrantT | Error>;
  let completeAnswers: Array<Error | null>;
  let tokenCounter: number;
  /** Fake storage: bytes it holds for the one upload URL, and the calls it saw. */
  let storage: { offset: number | null; creates: number; heads: number; patches: TusPatchOptionsT[]; tokens: string[] };
  let patchFaults: Array<Error | null>;
  let uploaders: RecordingUploader[];

  const grant = (): RecordingUploadGrantT => {
    tokenCounter += 1;
    return {
      state: "uploading",
      recording_id: RECORDING_ID,
      storage_path: `orgs/o/recordings/${RECORDING_ID}/source.mp4`,
      bucket: "postpro-media",
      content_type: "video/mp4",
      tus_endpoint: ENDPOINT,
      token: `token-${tokenCounter}`,
      token_ttl_s: 7200,
      chunk_size_bytes: CHUNK,
    };
  };

  const platform: RecordingUploadPlatformT = {
    begin: async (request) => {
      begins.push(request);
      const answer = beginAnswers.shift() ?? grant();
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    complete: async (request) => {
      completes.push(request);
      const answer = completeAnswers.shift();
      if (answer) {
        throw answer;
      }
    },
    abort: async (request) => {
      aborts.push(request);
    },
  };

  const urlTransport: TusTransportT = {
    parseUrl: (rawUrl) => new URL(rawUrl),
    request: () => {
      throw new Error("no network in this test");
    },
  };

  const tus = {
    urlTransport,
    create: async (options: { token: string }) => {
      storage.creates += 1;
      storage.tokens.push(options.token);
      storage.offset = 0;
      return UPLOAD_URL;
    },
    getOffset: async (options: { token: string }) => {
      storage.heads += 1;
      storage.tokens.push(options.token);
      if (storage.offset === null) {
        throw new TusHttpError("HEAD", 404, "");
      }
      return storage.offset;
    },
    patchChunk: async (options: TusPatchOptionsT) => {
      storage.patches.push(options);
      storage.tokens.push(options.token);
      const fault = patchFaults.shift();
      if (fault) {
        throw fault;
      }
      options.onBytesSent?.(options.length);
      storage.offset = options.offset + options.length;
      return storage.offset;
    },
  };

  const createUploader = (overrides: { maxTaskAttempts?: number } = {}) => {
    const uploader = new RecordingUploader({
      queueStore: {
        load: async () => structuredClone(records),
        save: async (next) => {
          records = structuredClone(next);
        },
      },
      settingsStore: {
        load: async () => settings,
        save: async (next) => {
          settings = next;
        },
      },
      platform,
      tus,
      publish: (status) => published.push(status),
      logger,
      now: () => clock,
      // The tests drive drain() themselves.
      startupDrainDelayMs: 60 * 60_000,
      ...overrides,
    });
    uploaders.push(uploader);
    return uploader;
  };

  const writeRecording = async (name = "Broadify-Meeting-1.mp4", bytes = 2500) => {
    const filePath = path.join(dir, name);
    const content = randomBytes(bytes);
    await fs.writeFile(filePath, content);
    return { filePath, content, sha256: createHash("sha256").update(content).digest("hex") };
  };

  const recordingStatus = (filePath: string, overrides: Record<string, unknown> = {}) => ({
    engine: { program_revision: 1 },
    recording: { active: true, file_path: `${filePath}.part`, codec: "h264", container: "mp4", elapsed_seconds: 42, last_error: "", ...overrides },
    program_format: PROGRAM_FORMAT,
  });

  /** A started uploader that saw one recording start and stop. */
  const recordOnce = async (
    uploader: RecordingUploader,
    filePath: string,
    recording: Record<string, unknown> = {},
    stopped: Record<string, unknown> = {},
  ) => {
    uploader.handleMeetingStatus(recordingStatus(filePath, recording));
    uploader.handleMeetingStatus(recordingStatus(filePath, { ...recording, active: false, file_path: filePath, ...stopped }));
    await uploader.whenTransitionsSettled();
  };

  const queuedRecord = async (overrides: Partial<RecordingUploadRecordT> = {}): Promise<RecordingUploadRecordT> => {
    const { filePath } = await writeRecording(`${randomUUID()}.mp4`);
    const stat = await fs.stat(filePath);
    return {
      id: randomUUID(),
      file_path: filePath,
      size_bytes: stat.size,
      mtime_ms: stat.mtimeMs,
      codec: "h264",
      container: "mp4",
      width: 1920,
      height: 1080,
      fps: 30,
      duration_ms: 42_000,
      recorded_at_ms: clock - 60_000,
      enqueued_at_ms: clock,
      state: "queued",
      sha256: null,
      recording_id: null,
      upload_url: null,
      bytes_uploaded: 0,
      restarted: false,
      upload_restarts: 0,
      attempts: 0,
      answered_attempts: 0,
      next_attempt_at: 0,
      error_code: null,
      updated_at_ms: clock,
      ...overrides,
    };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-recording-uploader-"));
    clock = 1_763_800_000_000;
    records = [];
    settings = { enabled: true, updated_at_ms: 1 };
    published = [];
    logger = { info: jest.fn(), warn: jest.fn() };
    begins = [];
    completes = [];
    aborts = [];
    beginAnswers = [];
    completeAnswers = [];
    tokenCounter = 0;
    storage = { offset: null, creates: 0, heads: 0, patches: [], tokens: [] };
    patchFaults = [];
    uploaders = [];
  });

  afterEach(async () => {
    await Promise.all(uploaders.map((uploader) => uploader.shutdown()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  describe("from recording to upload", () => {
    it("enqueues a finished recording and uploads it: begin, hash, chunks, complete", async () => {
      const { filePath, content, sha256 } = await writeRecording();
      const before = await fs.stat(filePath);
      const uploader = createUploader();
      await uploader.initialize();

      uploader.handleMeetingStatus(recordingStatus(filePath));
      await uploader.whenTransitionsSettled();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ state: "recording", file_path: filePath, codec: "h264", container: "mp4", ...PROGRAM_FORMAT });
      expect(uploader.getStatus().tasks).toEqual([]);

      uploader.handleMeetingStatus(recordingStatus(filePath, { active: false, file_path: filePath }));
      await uploader.whenTransitionsSettled();
      expect(records[0]).toMatchObject({ state: "queued", size_bytes: content.length, duration_ms: 42_000 });

      await uploader.drain();

      expect(begins).toEqual([
        {
          client_recording_id: records[0].id,
          file_name: "Broadify-Meeting-1.mp4",
          size_bytes: content.length,
          codec: "h264",
          container: "mp4",
          width: 1920,
          height: 1080,
          fps: 30,
          duration_ms: 42_000,
          recorded_at_ms: clock,
          bytes_uploaded: 0,
        },
      ]);
      expect(storage.patches.map((patch) => [patch.offset, patch.length])).toEqual([[0, 1000], [1000, 1000], [2000, 500]]);
      expect(storage.patches.every((patch) => patch.filePath === filePath)).toBe(true);
      expect(completes).toEqual([{ recording_id: RECORDING_ID, size_bytes: content.length, sha256 }]);
      expect(records[0]).toMatchObject({ state: "done", bytes_uploaded: content.length, upload_url: null, error_code: null, sha256 });
      expect(aborts).toEqual([]);

      // The local file is only ever read.
      const after = await fs.stat(filePath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect((await fs.readFile(filePath)).equals(content)).toBe(true);
      expect(await fs.readdir(dir)).toEqual(["Broadify-Meeting-1.mp4"]);
    });

    it("reports every state on the way and only basenames: no path, URL or token leaves the bridge", async () => {
      const { filePath } = await writeRecording();
      const uploader = createUploader();
      await uploader.initialize();
      await recordOnce(uploader, filePath);
      await uploader.drain();

      const states = published.map((status) => status.tasks[0]?.state);
      expect(states.filter((state, index) => state !== states[index - 1])).toEqual(["queued", "hashing", "uploading", "completing", "done"]);
      expect(published.at(-1)).toEqual({
        enabled: true,
        available: true,
        last_skipped: null,
        tasks: [
          {
            id: records[0].id,
            recording_id: RECORDING_ID,
            file_name: "Broadify-Meeting-1.mp4",
            state: "done",
            size_bytes: 2500,
            bytes_uploaded: 2500,
            attempts: 0,
            next_attempt_at: null,
            error_code: null,
            updated_at: clock,
          },
        ],
      });
      const everythingReported = JSON.stringify(published);
      const everythingLogged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      for (const text of [everythingReported, everythingLogged]) {
        expect(text).not.toContain(dir);
        expect(text).not.toContain("supabase.co");
        expect(text).not.toMatch(/token-\d/);
      }
      expect(JSON.stringify(records)).not.toMatch(/token-\d/);
    });

    it("does nothing while the opt-in is off: no task, no platform call, nothing reported", async () => {
      settings = { enabled: false, updated_at_ms: 0 };
      const { filePath } = await writeRecording();
      const uploader = createUploader();
      await uploader.initialize();
      await recordOnce(uploader, filePath);
      await uploader.drain();

      expect(records).toEqual([]);
      expect(begins).toEqual([]);
      expect(uploader.getStatus()).toEqual({ enabled: false, available: true, tasks: [], last_skipped: null });
      expect(published).toEqual([]);
    });

    it("counts a recording when the opt-in was switched on while it ran", async () => {
      settings = { enabled: false, updated_at_ms: 0 };
      const { filePath } = await writeRecording();
      const uploader = createUploader();
      await uploader.initialize();
      uploader.handleMeetingStatus(recordingStatus(filePath));
      await uploader.whenTransitionsSettled();
      await uploader.configure(true);
      uploader.handleMeetingStatus(recordingStatus(filePath, { active: false }));
      await uploader.whenTransitionsSettled();
      expect(records[0]?.state).toBe("queued");
    });

    it("keeps a ProRes master local and says why", async () => {
      const { filePath } = await writeRecording("Broadify-Meeting-2.mov");
      const uploader = createUploader();
      await uploader.initialize();
      await recordOnce(uploader, filePath, { codec: "prores_422", container: "mov" });
      await uploader.drain();

      expect(records).toEqual([]);
      expect(begins).toEqual([]);
      expect(uploader.getStatus().last_skipped).toEqual({ file_name: "Broadify-Meeting-2.mov", at: clock, reason: "prores_master_local" });
      expect(published.at(-1)?.last_skipped?.reason).toBe("prores_master_local");
    });

    it.each([
      ["a recorder error", { last_error: "finalize_timeout" }, false, "recording_failed"],
      ["a leftover .part file", {}, true, "file_incomplete"],
    ])("does not upload after %s", async (_name, stopped, withPart, reason) => {
      const { filePath } = await writeRecording();
      if (withPart) {
        await fs.writeFile(`${filePath}.part`, "partial");
      }
      const uploader = createUploader();
      await uploader.initialize();
      await recordOnce(uploader, filePath, {}, stopped);
      expect(records).toEqual([]);
      expect(uploader.getStatus().last_skipped?.reason).toBe(reason);
    });

    it("does not upload a recording whose file does not exist", async () => {
      const uploader = createUploader();
      await uploader.initialize();
      await recordOnce(uploader, path.join(dir, "missing.mp4"));
      expect(records).toEqual([]);
      expect(uploader.getStatus().last_skipped?.reason).toBe("file_missing");
    });

    it("is not fooled by a status that cannot say what the recorder does", async () => {
      const { filePath } = await writeRecording();
      // While the recording runs only the .part file exists.
      await fs.rename(filePath, `${filePath}.part`);
      const uploader = createUploader();
      await uploader.initialize();
      uploader.handleMeetingStatus(recordingStatus(filePath));
      uploader.handleMeetingStatus({ engine: null, engineError: "Request timed out", recording: null, program_format: PROGRAM_FORMAT });
      uploader.handleMeetingStatus({ engine: { program_revision: 1 }, recording: null, program_format: PROGRAM_FORMAT });
      await uploader.whenTransitionsSettled();
      expect(records.map((record) => record.state)).toEqual(["recording"]);
      expect(uploader.getStatus().last_skipped).toBeNull();

      await fs.rename(`${filePath}.part`, filePath);
      uploader.handleMeetingStatus(recordingStatus(filePath, { active: false }));
      await uploader.whenTransitionsSettled();
      expect(records.map((record) => record.state)).toEqual(["queued"]);
    });

    it("an engine that is gone ends the recording: a crash leaves the .part file and nothing is uploaded", async () => {
      const { filePath } = await writeRecording();
      await fs.rename(filePath, `${filePath}.part`);
      const uploader = createUploader();
      await uploader.initialize();
      uploader.handleMeetingStatus(recordingStatus(filePath));
      uploader.handleMeetingStatus({ engine: null, recording: null, program_format: null });
      await uploader.whenTransitionsSettled();
      expect(records).toEqual([]);
      expect(uploader.getStatus().last_skipped?.reason).toBe("file_incomplete");
    });

    it("startup settles a recording that was running when the bridge stopped", async () => {
      const finished = await queuedRecord({ state: "recording", size_bytes: 0, mtime_ms: 0, duration_ms: 0, enqueued_at_ms: 0 });
      const crashed = await queuedRecord({ state: "recording", size_bytes: 0, mtime_ms: 0, duration_ms: 0, enqueued_at_ms: 0 });
      await fs.rename(crashed.file_path, `${crashed.file_path}.part`);
      records = [finished, crashed];

      const uploader = createUploader();
      await uploader.initialize();

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ id: finished.id, state: "queued", size_bytes: 2500, enqueued_at_ms: clock });
      // Without the recorder's elapsed time the duration is the span from start to the file's last write.
      expect(records[0].duration_ms).toBeGreaterThan(0);
      expect(uploader.getStatus().last_skipped).toEqual({ file_name: path.basename(crashed.file_path), at: clock, reason: "file_incomplete" });
    });
  });

  describe("resume and restart", () => {
    it("resumes an interrupted upload at the server's offset with a fresh token", async () => {
      records = [await queuedRecord({ state: "uploading", sha256: "b".repeat(64), recording_id: RECORDING_ID, upload_url: UPLOAD_URL, bytes_uploaded: 1000 })];
      storage.offset = 2000;
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();

      expect(begins[0].bytes_uploaded).toBe(1000);
      expect(storage.creates).toBe(0);
      expect(storage.heads).toBe(1);
      expect(storage.patches.map((patch) => [patch.offset, patch.length])).toEqual([[2000, 500]]);
      // The persisted hash is reused: no second pass over the file.
      expect(completes[0].sha256).toBe("b".repeat(64));
      expect(records[0].state).toBe("done");
    });

    it("hashes again when the bridge stopped while hashing", async () => {
      records = [await queuedRecord({ state: "hashing" })];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(completes[0].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(records[0].state).toBe("done");
    });

    it("only repeats complete when the bytes were already on the server", async () => {
      records = [await queuedRecord({ state: "completing", sha256: "c".repeat(64), recording_id: RECORDING_ID, bytes_uploaded: 2500 })];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(begins).toEqual([]);
      expect(storage.patches).toEqual([]);
      expect(completes).toEqual([{ recording_id: RECORDING_ID, size_bytes: 2500, sha256: "c".repeat(64) }]);
      expect(records[0].state).toBe("done");
    });

    it("is done at once when the platform already holds the recording", async () => {
      records = [await queuedRecord()];
      beginAnswers = [{ state: "ready", recording_id: RECORDING_ID }];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(storage.creates).toBe(0);
      expect(completes).toEqual([]);
      expect(records[0]).toMatchObject({ state: "done", recording_id: RECORDING_ID });
    });

    it("ignores a persisted upload URL on another origin and creates a new upload", async () => {
      records = [await queuedRecord({ state: "uploading", sha256: "b".repeat(64), upload_url: "https://elsewhere.example/storage/v1/upload/resumable/sign/x", bytes_uploaded: 1000 })];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(storage.heads).toBe(0);
      expect(storage.creates).toBe(1);
      expect(storage.patches[0].offset).toBe(0);
      expect(records[0].state).toBe("done");
    });

    it("continues after an offset conflict with the server's offset", async () => {
      records = [await queuedRecord()];
      patchFaults = [null, new TusHttpError("PATCH", 409, "")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(storage.heads).toBe(1);
      expect(storage.patches.map((patch) => patch.offset)).toEqual([0, 1000, 1000, 2000]);
      expect(records[0].state).toBe("done");
    });

    /** Runs the queue with the clock moving on by `stepMs` during every chunk. */
    const drainWithSlowChunks = async (uploader: RecordingUploader, stepMs: number) => {
      const patch = tus.patchChunk;
      tus.patchChunk = async (options) => {
        clock += stepMs;
        return patch(options);
      };
      try {
        await uploader.drain();
      } finally {
        tus.patchChunk = patch;
      }
    };

    it("keeps one token for an upload that is well inside the token's lifetime", async () => {
      const { filePath } = await writeRecording("long.mp4", 5500);
      const stat = await fs.stat(filePath);
      records = [await queuedRecord({ file_path: filePath, size_bytes: stat.size, mtime_ms: stat.mtimeMs })];
      const uploader = createUploader();
      await uploader.initialize();
      // Six chunks, 20 minutes each: 100 minutes of a 120 minute token.
      await drainWithSlowChunks(uploader, 20 * 60_000);
      expect(storage.patches.map((patch) => patch.token)).toEqual(Array(6).fill("token-1"));
      expect(storage.creates).toBe(1);
      expect(records[0]).toMatchObject({ state: "done", upload_restarts: 0 });
    });

    it("replaces the token shortly before it expires and continues the same upload", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      // 2 hour token, replaced 10 minutes before its end: after the first chunk, not before.
      await drainWithSlowChunks(uploader, 111 * 60_000);
      expect(storage.patches.map((patch) => patch.token)).toEqual(["token-1", "token-2", "token-3"]);
      expect(begins.map((begin) => begin.bytes_uploaded)).toEqual([0, 1000, 2000]);
      expect(storage.creates).toBe(1);
      expect(records[0].state).toBe("done");
    });

    it("measures the token's age from its begin, so the time spent hashing counts", async () => {
      records = [await queuedRecord()];
      const realBegin = platform.begin;
      let first = true;
      platform.begin = async (request) => {
        const answer = await realBegin(request);
        if (first) {
          // Stands for a long hash pass between begin and the first chunk.
          first = false;
          clock += 115 * 60_000;
        }
        return answer;
      };
      const uploader = createUploader();
      await uploader.initialize();
      try {
        await uploader.drain();
      } finally {
        platform.begin = realBegin;
      }
      expect(storage.patches[0].token).toBe("token-2");
      expect(records[0].state).toBe("done");
    });

    it("a storage that refuses every re-issued token on the upload ends the task after a bounded number of restarts", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      const head = tus.getOffset;
      const patch = tus.patchChunk;
      // The storage accepts a token only on an upload created with it.
      let createdWith = "";
      const create = tus.create;
      tus.create = async (options) => {
        createdWith = options.token;
        return create(options);
      };
      tus.getOffset = async (options) => {
        if (options.token !== createdWith) {
          throw new TusHttpError("HEAD", 403, "signature");
        }
        return head(options);
      };
      tus.patchChunk = async (options) => {
        if (options.token !== createdWith) {
          throw new TusHttpError("PATCH", 403, "signature");
        }
        // Every chunk takes longer than the token lives: it is replaced before the next one.
        clock += 111 * 60_000;
        return patch(options);
      };
      try {
        await uploader.drain();
      } finally {
        tus.create = create;
        tus.getOffset = head;
        tus.patchChunk = patch;
      }
      // One upload plus three restarts from byte 0, then a clear end instead of a loop.
      expect(storage.creates).toBe(4);
      expect(records[0]).toMatchObject({ state: "failed", error_code: "upload_restarts_exhausted", upload_restarts: 3 });
      expect(aborts).toEqual([{ recording_id: RECORDING_ID, error_code: "upload_restarts_exhausted" }]);
      await uploader.drain();
      expect(storage.creates).toBe(4);
    });

    it("asks the platform once more before the last chunk and stops when the recording was deleted meanwhile", async () => {
      records = [await queuedRecord()];
      beginAnswers = [grant(), platformError(410, "recording_deleted")];
      const uploader = createUploader();
      await uploader.initialize();
      await drainWithSlowChunks(uploader, 5 * 60_000);
      // The last chunk, with which the storage would create the object, is never sent.
      expect(storage.patches.map((patch) => patch.offset)).toEqual([0, 1000]);
      expect(begins.map((begin) => begin.bytes_uploaded)).toEqual([0, 2000]);
      expect(completes).toEqual([]);
      expect(records[0]).toMatchObject({ state: "cancelled", error_code: "recording_deleted" });
      expect(aborts).toEqual([]);
    });

    it("the question before the last chunk does not change the token in use", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      await drainWithSlowChunks(uploader, 5 * 60_000);
      expect(begins).toHaveLength(2);
      expect(storage.patches.map((patch) => patch.token)).toEqual(["token-1", "token-1", "token-1"]);
      expect(records[0].state).toBe("done");
    });

    it("complete on a row the platform closed meanwhile: begin reopens it and complete is repeated", async () => {
      records = [await queuedRecord({ state: "completing", sha256: "c".repeat(64), recording_id: RECORDING_ID, bytes_uploaded: 2500 })];
      completeAnswers = [platformError(409, "recording_not_uploading")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(begins).toHaveLength(1);
      expect(completes).toHaveLength(2);
      // No byte is sent again.
      expect(storage.creates).toBe(0);
      expect(storage.patches).toEqual([]);
      expect(records[0]).toMatchObject({ state: "done", attempts: 0 });
    });

    it("a row that stays closed after the reopen ends the task", async () => {
      records = [await queuedRecord({ state: "completing", sha256: "c".repeat(64), recording_id: RECORDING_ID, bytes_uploaded: 2500 })];
      completeAnswers = [platformError(409, "recording_not_uploading"), platformError(409, "recording_not_uploading")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(completes).toHaveLength(2);
      expect(records[0]).toMatchObject({ state: "failed", error_code: "recording_not_uploading" });
    });

    it("re-issues the token after the storage refused it and starts over when the upload is gone too", async () => {
      records = [await queuedRecord()];
      patchFaults = [null, new TusHttpError("PATCH", 403, "signature")];
      const uploader = createUploader();
      await uploader.initialize();
      const head = tus.getOffset;
      tus.getOffset = async (options) => {
        storage.offset = null;
        return head(options);
      };
      try {
        await uploader.drain();
      } finally {
        tus.getOffset = head;
      }
      expect(begins).toHaveLength(2);
      expect(storage.creates).toBe(2);
      expect(storage.patches.map((patch) => [patch.offset, patch.token])).toEqual([
        [0, "token-1"],
        [1000, "token-1"],
        [0, "token-2"],
        [1000, "token-2"],
        [2000, "token-2"],
      ]);
      expect(records[0].state).toBe("done");
    });
  });

  describe("failures", () => {
    it("retries a network failure with backoff and keeps the progress", async () => {
      records = [await queuedRecord()];
      patchFaults = [null, new Error("socket hang up")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();

      expect(records[0]).toMatchObject({ state: "uploading", attempts: 1, answered_attempts: 0, bytes_uploaded: 1000, error_code: "network_error", upload_url: UPLOAD_URL });
      const waitMs = records[0].next_attempt_at - clock;
      expect(waitMs).toBeGreaterThanOrEqual(24_000);
      expect(waitMs).toBeLessThanOrEqual(36_000);
      expect(uploader.getStatus().tasks[0]).toMatchObject({ state: "uploading", attempts: 1, next_attempt_at: records[0].next_attempt_at });

      // Not due yet: nothing happens.
      await uploader.drain();
      expect(begins).toHaveLength(1);

      clock = records[0].next_attempt_at;
      await uploader.drain();
      expect(storage.creates).toBe(1);
      expect(records[0]).toMatchObject({ state: "done", attempts: 0 });
    });

    it("counts only failures without byte progress and gives up after the limit", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader({ maxTaskAttempts: 3 });
      await uploader.initialize();
      beginAnswers = [platformError(503, null), platformError(503, null), platformError(503, null)];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await uploader.drain();
        clock += 2 * 60 * 60_000;
      }
      expect(begins).toHaveLength(3);
      expect(records[0]).toMatchObject({ state: "failed", error_code: "upload_retries_exhausted", attempts: 3, answered_attempts: 3 });
      // No platform row is known yet, so there is nothing to abort.
      expect(aborts).toEqual([]);
      await uploader.drain();
      expect(begins).toHaveLength(3);
    });

    it("being offline does not use up the attempts: only the seven days end the task", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader({ maxTaskAttempts: 3 });
      await uploader.initialize();
      const offline = new TypeError("fetch failed");
      beginAnswers = Array.from({ length: 60 }, () => offline);
      for (let attempt = 1; attempt <= 60; attempt += 1) {
        await uploader.drain();
        clock += 60 * 60_000;
      }
      // Two and a half days without network: still waiting, with the longest backoff.
      expect(begins).toHaveLength(60);
      expect(records[0]).toMatchObject({ state: "queued", attempts: 60, answered_attempts: 0, error_code: "network_error" });
      expect(records[0].next_attempt_at - clock).toBeLessThanOrEqual(0);

      // Back online: the upload runs.
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "done", attempts: 0 });
    });

    it("answered failures still count while offline attempts lie in between", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader({ maxTaskAttempts: 2 });
      await uploader.initialize();
      beginAnswers = [platformError(503, null), new Error("ECONNRESET"), new Error("ECONNRESET"), platformError(401, null)];
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await uploader.drain();
        clock += 2 * 60 * 60_000;
      }
      expect(records[0]).toMatchObject({ state: "failed", error_code: "upload_retries_exhausted", attempts: 4, answered_attempts: 2 });
    });

    it("an upload the storage refuses to create fails at once with the storage's status", async () => {
      records = [await queuedRecord()];
      const create = tus.create;
      tus.create = async () => {
        throw new TusHttpError("POST", 413, "Maximum size exceeded");
      };
      const uploader = createUploader();
      await uploader.initialize();
      try {
        await uploader.drain();
      } finally {
        tus.create = create;
      }
      expect(records[0]).toMatchObject({ state: "failed", error_code: "storage_http_413", attempts: 0 });
      expect(aborts).toEqual([{ recording_id: RECORDING_ID, error_code: "storage_http_413" }]);
    });

    it("does not offer a recording above the platform's size limit", async () => {
      records = [await queuedRecord({ size_bytes: 50 * 1024 * 1024 * 1024 + 1 })];
      const uploader = createUploader();
      await uploader.initialize();
      // Stands for a file of that size on disk.
      const stat = jest.spyOn(fs, "stat").mockResolvedValue({ isFile: () => true, size: records[0].size_bytes, mtimeMs: records[0].mtime_ms } as never);
      try {
        await uploader.drain();
      } finally {
        stat.mockRestore();
      }
      expect(begins).toEqual([]);
      expect(records[0]).toMatchObject({ state: "failed", error_code: "recording_too_large" });
    });

    it("tells the platform a file name of at most 200 characters, extension kept", async () => {
      // Longer than the platform takes, shorter than the 255 bytes a file system allows.
      const name = `${"a".repeat(180)}${"\u{1F3AC}".repeat(15)}.mp4`;
      expect(name.length).toBe(214);
      const { filePath } = await writeRecording(name);
      const stat = await fs.stat(filePath);
      records = [await queuedRecord({ file_path: filePath, size_bytes: stat.size, mtime_ms: stat.mtimeMs })];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      // 180 letters + 8 emoji (16 units) + ".mp4" = 200; no half emoji.
      expect(begins[0].file_name).toBe(`${"a".repeat(180)}${"\u{1F3AC}".repeat(8)}.mp4`);
      expect(begins[0].file_name).toHaveLength(200);
      expect(records[0].state).toBe("done");
    });

    it("tells the platform when an upload it knows fails for good", async () => {
      records = [await queuedRecord({ state: "uploading", sha256: "b".repeat(64), recording_id: RECORDING_ID, upload_url: UPLOAD_URL })];
      await fs.appendFile(records[0].file_path, "changed after the stop");
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "failed", error_code: "file_changed" });
      expect(aborts).toEqual([{ recording_id: RECORDING_ID, error_code: "file_changed" }]);
      expect(begins).toEqual([]);
    });

    it("fails when the file is gone from a folder that is there", async () => {
      records = [await queuedRecord()];
      await fs.rm(records[0].file_path);
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "failed", error_code: "file_missing" });
    });

    it("waits when the folder of the file is not there (volume not mounted) and uploads once it is back", async () => {
      const volume = path.join(dir, "external-disk");
      await fs.mkdir(volume);
      const original = await queuedRecord({ state: "uploading", sha256: null, recording_id: RECORDING_ID });
      const filePath = path.join(volume, "Broadify-Meeting-1.mp4");
      await fs.rename(original.file_path, filePath);
      const stat = await fs.stat(filePath);
      records = [{ ...original, file_path: filePath, mtime_ms: stat.mtimeMs }];
      const parked = path.join(dir, "unmounted");
      await fs.rename(volume, parked);

      const uploader = createUploader({ maxTaskAttempts: 2 });
      await uploader.initialize();
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await uploader.drain();
        clock += 60 * 60_000;
      }
      expect(records[0]).toMatchObject({ state: "uploading", attempts: 5, answered_attempts: 0, error_code: "file_unavailable" });
      expect(aborts).toEqual([]);
      expect(begins).toEqual([]);

      await fs.rename(parked, volume);
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "done", attempts: 0 });
    });

    it.each(["EACCES", "EIO", "ENOTDIR"])("waits on %s instead of giving the recording up", async (code) => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      const realStat = fs.stat;
      const stat = jest.spyOn(fs, "stat").mockImplementation(async (target, ...rest) => {
        if (target === records[0].file_path) {
          throw Object.assign(new Error(`${code}: ${String(target)}`), { code });
        }
        return realStat(target as string, ...(rest as []));
      });
      try {
        await uploader.drain();
      } finally {
        stat.mockRestore();
      }
      expect(records[0]).toMatchObject({ state: "queued", attempts: 1, error_code: "file_unavailable" });
      // The log line names the file by basename and the code only.
      expect(String(logger.warn.mock.calls.at(-1)?.[0])).not.toContain(dir);
    });

    it("a file that stays unavailable ends with the seven days", async () => {
      records = [await queuedRecord()];
      await fs.rm(dir, { recursive: true, force: true });
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "queued", error_code: "file_unavailable" });
      clock += 7 * DAY_MS + 1;
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "failed", error_code: "upload_expired" });
    });

    it("fails a task that could not be uploaded within seven days", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      clock += 7 * DAY_MS + 1;
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "failed", error_code: "upload_expired" });
      expect(begins).toEqual([]);
    });

    it.each(["upload_not_enabled", "bridge_not_linked"])("%s: cancels the task and switches the local hint off", async (code) => {
      records = [await queuedRecord()];
      beginAnswers = [platformError(403, code)];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "cancelled", error_code: code });
      expect(settings.enabled).toBe(false);
      expect(published.at(-1)).toMatchObject({ enabled: false });
      // The platform never opened a row for this task.
      expect(aborts).toEqual([]);
    });

    it("an upload the platform refuses midway is cancelled and its row is closed", async () => {
      records = [await queuedRecord({ state: "uploading", sha256: "b".repeat(64), recording_id: RECORDING_ID, upload_url: UPLOAD_URL, bytes_uploaded: 1000 })];
      beginAnswers = [platformError(403, "upload_not_enabled")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "cancelled", error_code: "upload_not_enabled" });
      expect(aborts).toEqual([{ recording_id: RECORDING_ID, error_code: "upload_not_enabled" }]);
    });

    it("recording_deleted: cancels the task and leaves the hint on", async () => {
      records = [await queuedRecord()];
      beginAnswers = [platformError(410, "recording_deleted")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "cancelled", error_code: "recording_deleted" });
      expect(settings.enabled).toBe(true);
    });

    it("recording_deleted on a known row: nothing is left to close", async () => {
      records = [await queuedRecord({ state: "uploading", sha256: "b".repeat(64), recording_id: RECORDING_ID, upload_url: UPLOAD_URL, bytes_uploaded: 1000 })];
      beginAnswers = [platformError(410, "recording_deleted")];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "cancelled", error_code: "recording_deleted" });
      expect(aborts).toEqual([]);
    });

    it.each([
      [403, "limit_minutes", "limit_minutes"],
      [413, "recording_too_large", "recording_too_large"],
      [404, "recording_not_found", "recording_not_found"],
      [400, null, "invalid_request"],
    ])("HTTP %i %p fails without a retry", async (status, code, errorCode) => {
      records = [await queuedRecord()];
      beginAnswers = [platformError(status, code)];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records[0]).toMatchObject({ state: "failed", error_code: errorCode, attempts: 0 });
      expect(storage.creates).toBe(0);
    });

    it.each(["size_mismatch", "object_missing"])("%s at complete: uploads once more from byte 0, then fails", async (code) => {
      records = [await queuedRecord()];
      completeAnswers = [platformError(409, code), platformError(409, code)];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();

      expect(storage.creates).toBe(2);
      expect(storage.patches.map((patch) => patch.offset)).toEqual([0, 1000, 2000, 0, 1000, 2000]);
      expect(completes).toHaveLength(2);
      expect(records[0]).toMatchObject({ state: "failed", error_code: code, restarted: true });
      expect(aborts).toEqual([{ recording_id: RECORDING_ID, error_code: code }]);
    });

    it("a failed task does not block the next one", async () => {
      const broken = await queuedRecord({ enqueued_at_ms: clock - 10 });
      await fs.rm(broken.file_path);
      records = [broken, await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      expect(records.map((record) => record.state)).toEqual(["failed", "done"]);
    });
  });

  describe("settings, reporting, housekeeping", () => {
    it("configure stores the hint and publishes only on a change", async () => {
      settings = { enabled: false, updated_at_ms: 0 };
      const uploader = createUploader();
      await uploader.initialize();
      expect(await uploader.configure(true)).toMatchObject({ enabled: true, available: true });
      expect(settings).toEqual({ enabled: true, updated_at_ms: clock });
      expect(published).toHaveLength(1);
      await uploader.configure(true);
      expect(published).toHaveLength(1);
      expect(await uploader.configure(false)).toMatchObject({ enabled: false });
      expect(settings.enabled).toBe(false);
    });

    it("switching the hint off stops new enqueues; a queued upload still runs", async () => {
      records = [await queuedRecord()];
      const { filePath } = await writeRecording("later.mp4");
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.configure(false);
      await recordOnce(uploader, filePath);
      await uploader.drain();
      expect(records.map((record) => record.state)).toEqual(["done"]);
    });

    it("publishes progress at most every two seconds", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      await uploader.drain();
      // The clock stands still during the upload: the three chunks produce no publish of their own.
      const uploadingPublishes = published.filter((status) => status.tasks[0].state === "uploading");
      expect(uploadingPublishes).toHaveLength(1);
    });

    it("reports the newest tasks first and at most twenty", async () => {
      records = await Promise.all(
        Array.from({ length: 25 }, (_unused, index) => queuedRecord({ enqueued_at_ms: clock + index, next_attempt_at: clock + DAY_MS })),
      );
      const uploader = createUploader();
      await uploader.initialize();
      const { tasks } = uploader.getStatus();
      expect(tasks).toHaveLength(20);
      expect(tasks[0].id).toBe(records[24].id);
      expect(tasks.every((task) => task.next_attempt_at === clock + DAY_MS)).toBe(true);
    });

    it("drops terminal records after seven days and keeps at most twenty", async () => {
      const terminal = (index: number, ageMs: number) =>
        queuedRecord({ state: index % 2 ? "done" : "failed", updated_at_ms: clock - ageMs, enqueued_at_ms: clock - ageMs });
      const old = await terminal(0, 8 * DAY_MS);
      const recent = await Promise.all(Array.from({ length: 23 }, (_unused, index) => terminal(index, index * 1000)));
      const pending = await queuedRecord({ next_attempt_at: clock + DAY_MS, enqueued_at_ms: clock - 30 * DAY_MS });
      records = [old, ...recent, pending];

      const uploader = createUploader();
      await uploader.initialize();

      const ids = records.map((record) => record.id);
      expect(ids).not.toContain(old.id);
      expect(ids).toContain(pending.id);
      expect(records.filter((record) => record.state !== "queued")).toHaveLength(20);
      expect(ids).toContain(recent[0].id);
      expect(ids).not.toContain(recent[22].id);
    });

    it("stops quietly on shutdown: the task stays as it is for the next start", async () => {
      records = [await queuedRecord()];
      const uploader = createUploader();
      await uploader.initialize();
      const patch = tus.patchChunk;
      tus.patchChunk = async (options) => {
        const result = await patch(options);
        void uploader.shutdown();
        return result;
      };
      try {
        await uploader.drain();
      } finally {
        tus.patchChunk = patch;
      }
      expect(records[0]).toMatchObject({ state: "uploading", bytes_uploaded: 1000, attempts: 0 });
      expect(aborts).toEqual([]);
    });
  });
});
