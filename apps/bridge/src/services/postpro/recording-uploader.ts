import { createHash, randomUUID } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import path from "node:path";
import type {
  MeetingRecordingUploadStatusT,
  MeetingRecordingUploadTaskStateT,
} from "@broadify/protocol";
import { meetingRecordingContainer } from "../meeting/meeting-recording-codecs.js";
import { computeBackoffDelayMs } from "../shared/backoff.js";
import {
  classifyRecordingUploadError,
  describeTransientUploadError,
  isAnsweredFailure,
  isRecordingRowClosed,
  type RecordingUploadPlatformT,
  type RecordingUploadTokenGrantT,
} from "./recording-upload-platform.js";
import {
  RECORDING_UPLOAD_TERMINAL_STATES,
  type RecordingUploadRecordT,
  type RecordingUploadSettingsT,
} from "./recording-upload-store.js";
import {
  decideFinishedRecording,
  diffRecordingSummary,
  isUploadableRecordingCodec,
  summarizeRecordingStatus,
  type RecordingTransitionT,
  type RecordingUploadSummaryT,
} from "./recording-upload-trigger.js";
import {
  isTusOffsetConflict,
  isTusTokenRefusal,
  isTusUploadGone,
  parseTusEndpoint,
  type TusUploadClient,
} from "./tus-upload-client.js";

const PART_SUFFIX = ".part";
const STARTUP_DRAIN_DELAY_MS = 5_000;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 30 * 60_000;
const RETRY_JITTER_RATIO = 0.2;
/**
 * Consecutive attempts without byte progress that the platform or the storage
 * answered with an error, before a task fails for good. Attempts that got no
 * answer at all (offline) do not count: the age limit alone bounds them.
 */
const MAX_TASK_ATTEMPTS = 40;
/** A task that could not be uploaded within this time after its enqueue fails with `upload_expired`. */
const MAX_TASK_AGE_MS = 7 * 24 * 60 * 60_000;
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_TERMINAL_RECORDS = 20;
const MAX_REPORTED_TASKS = 20;
const PROGRESS_PUBLISH_INTERVAL_MS = 2_000;
/** Recoveries (offset conflict, token refusal, lost upload URL) in a row without a byte of progress. */
const MAX_RECOVERIES_WITHOUT_PROGRESS = 3;
/** Times one task may start its upload again from byte 0 after the server already held bytes. */
const MAX_UPLOAD_RESTARTS = 3;
/**
 * The upload token is replaced this long before it expires (at most half its
 * lifetime early). Not earlier: whether the storage accepts a re-issued token
 * on an existing upload is not known, and a refusal costs a restart from byte 0.
 */
const TOKEN_REFRESH_MARGIN_MS = 10 * 60_000;
/** Before the last chunk the platform is asked once more whether it still wants the recording, unless it just said so. */
const FINAL_CHUNK_CONFIRM_AGE_MS = 60_000;
/** Limits of the platform's begin route; a recording beyond them is not offered at all. */
const MAX_RECORDING_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_FILE_NAME_LENGTH = 200;
const MAX_DURATION_MS = 24 * 60 * 60_000;
const HASH_READ_BYTES = 1024 * 1024;
/** Longest single timer; a later due time is simply re-armed (setTimeout overflows above 2^31 ms). */
const MAX_DRAIN_TIMER_MS = 60 * 60_000;

type QueueStoreLikeT = {
  load: () => Promise<RecordingUploadRecordT[]>;
  save: (records: RecordingUploadRecordT[]) => Promise<void>;
};

type SettingsStoreLikeT = {
  load: () => Promise<RecordingUploadSettingsT>;
  save: (settings: RecordingUploadSettingsT) => Promise<void>;
};

type TusClientLikeT = Pick<TusUploadClient, "create" | "getOffset" | "patchChunk" | "urlTransport">;

export type RecordingUploaderDepsT = {
  queueStore: QueueStoreLikeT;
  settingsStore: SettingsStoreLikeT;
  platform: RecordingUploadPlatformT;
  tus: TusClientLikeT;
  /** Called with a fresh snapshot whenever one should reach the web app. */
  publish: (status: MeetingRecordingUploadStatusT) => void;
  logger: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
  startupDrainDelayMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxTaskAttempts?: number;
};

/** A task ends for good with this code; not a failure to retry. */
class TerminalTaskError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TerminalTaskError";
  }
}

/**
 * The recording cannot be reached right now (volume not mounted, share down,
 * permission or I/O error). Unlike a file that is gone from a folder that is
 * there, this can heal: the task waits and tries again.
 */
class RecordingFileUnavailableError extends Error {
  constructor() {
    super("file_unavailable");
    this.name = "RecordingFileUnavailableError";
  }
}

/** An upload token with the time its begin was sent (its age is measured from there). */
type IssuedGrantT = { grant: RecordingUploadTokenGrantT; issuedAtMs: number };

/** The basename the platform is told, cut to its limit with the extension kept. */
function platformFileName(filePath: string): string {
  const base = path.basename(filePath);
  if (base.length <= MAX_FILE_NAME_LENGTH) {
    return base;
  }
  const extension = path.extname(base);
  let stem = "";
  // By code point, so a surrogate pair is never split.
  for (const character of base.slice(0, base.length - extension.length)) {
    if (stem.length + character.length + extension.length > MAX_FILE_NAME_LENGTH) {
      break;
    }
    stem += character;
  }
  return `${stem}${extension}`;
}

const isTerminal = (record: RecordingUploadRecordT): boolean =>
  (RECORDING_UPLOAD_TERMINAL_STATES as readonly string[]).includes(record.state);

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || (error as { code?: unknown }).code === "ABORT_ERR");

/**
 * Uploads finished meeting recordings to the platform (ADR-0011).
 *
 * One persisted queue, one task at a time: begin (the platform decides
 * whether the upload is allowed and issues the token) -> sha256 of the whole
 * file, streamed -> resumable tus upload in chunks streamed from disk ->
 * complete. Every step is safe to repeat, so a bridge restart or a network
 * loss resumes where the server is; failures are retried with backoff until
 * a bounded number of answered attempts or an age limit, then the task ends
 * as `failed`. The local file is only ever read.
 */
export class RecordingUploader {
  private readonly now: () => number;
  private readonly startupDrainDelayMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly maxTaskAttempts: number;

  private records: RecordingUploadRecordT[] = [];
  private settings: RecordingUploadSettingsT = { enabled: false, updated_at_ms: 0 };
  private lastSkipped: MeetingRecordingUploadStatusT["last_skipped"] = null;
  private loaded = false;
  private draining = false;
  private shuttingDown = false;
  private drainTimer: NodeJS.Timeout | null = null;
  private progressTimer: NodeJS.Timeout | null = null;
  private lastPublishedAt = 0;
  private abortController = new AbortController();
  /** Bytes of the running task handed to the socket, ahead of the persisted offset. */
  private liveProgress: { id: string; bytes: number } | null = null;
  private lastSummary: RecordingUploadSummaryT | null = null;
  private activeElapsedSeconds: number | null = null;
  private transitionChain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RecordingUploaderDepsT) {
    this.now = deps.now ?? Date.now;
    this.startupDrainDelayMs = deps.startupDrainDelayMs ?? STARTUP_DRAIN_DELAY_MS;
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
    this.maxTaskAttempts = deps.maxTaskAttempts ?? MAX_TASK_ATTEMPTS;
  }

  /**
   * Loads the queue and the opt-in hint, settles recordings that were still
   * running when the bridge last stopped (crash or shutdown) by the same
   * rule as a normal stop, and arms the drain.
   */
  async initialize(): Promise<void> {
    this.records = await this.deps.queueStore.load();
    this.settings = await this.deps.settingsStore.load();
    this.loaded = true;
    const loadedCount = this.records.length;
    const leftovers = this.records.filter((candidate) => candidate.state === "recording");
    for (const record of leftovers) {
      await this.finishRecording(record, null, null);
    }
    this.pruneTerminalRecords();
    // A bridge that never recorded with the upload in reach writes nothing at startup.
    if (leftovers.length > 0 || this.records.length !== loadedCount) {
      await this.persist();
    }
    if (this.pendingTasks().length > 0) {
      this.scheduleDrain(this.startupDrainDelayMs);
    }
  }

  /**
   * Feeds one meeting status (every published status of the helper manager).
   * Synchronous and never throwing: the transitions it finds are settled on
   * an internal chain.
   */
  handleMeetingStatus(status: Record<string, unknown> | null | undefined): void {
    if (!this.loaded || this.shuttingDown) {
      return;
    }
    const next = summarizeRecordingStatus(status);
    if (!next) {
      return;
    }
    const transitions = diffRecordingSummary(this.lastSummary, next);
    this.lastSummary = next;
    for (const transition of transitions) {
      if (transition.type === "progress") {
        this.activeElapsedSeconds = transition.elapsedSeconds;
        continue;
      }
      // Read here, not on the chain: the next status may already belong to another recording.
      const elapsedSeconds = this.activeElapsedSeconds;
      this.activeElapsedSeconds = null;
      this.transitionChain = this.transitionChain
        .then(() => this.applyTransition(transition, elapsedSeconds))
        .catch((error: unknown) => {
          // Never the message: a file-system error carries the full path.
          const kind = error instanceof Error ? error.name : "unknown";
          this.deps.logger.warn(`[RecordingUpload] Could not settle a recording transition (${kind})`);
        });
    }
  }

  /** Resolves when every transition found so far is settled (tests, shutdown). */
  whenTransitionsSettled(): Promise<void> {
    return this.transitionChain;
  }

  /**
   * Stores the opt-in hint pushed by the web app. Switching it off stops new
   * enqueues; tasks already in the queue keep running (the platform decides
   * at every begin).
   */
  async configure(enabled: boolean): Promise<MeetingRecordingUploadStatusT> {
    if (this.settings.enabled !== enabled) {
      this.settings = { enabled, updated_at_ms: this.now() };
      await this.deps.settingsStore.save(this.settings);
      this.deps.logger.info(`[RecordingUpload] Automatic upload ${enabled ? "enabled" : "disabled"}`);
      this.publishNow();
    }
    return this.getStatus();
  }

  getStatus(): MeetingRecordingUploadStatusT {
    const now = this.now();
    const tasks = this.records
      .filter((record) => record.state !== "recording")
      .sort((a, b) => b.enqueued_at_ms - a.enqueued_at_ms)
      .slice(0, MAX_REPORTED_TASKS)
      .map((record) => ({
        id: record.id,
        recording_id: record.recording_id,
        file_name: path.basename(record.file_path),
        state: record.state as MeetingRecordingUploadTaskStateT,
        size_bytes: record.size_bytes,
        bytes_uploaded:
          this.liveProgress?.id === record.id
            ? Math.max(record.bytes_uploaded, this.liveProgress.bytes)
            : record.bytes_uploaded,
        attempts: record.attempts,
        next_attempt_at: !isTerminal(record) && record.next_attempt_at > now ? record.next_attempt_at : null,
        error_code: record.error_code,
        updated_at: record.updated_at_ms,
      }));
    return { enabled: this.settings.enabled, available: true, tasks, last_skipped: this.lastSkipped };
  }

  /** Stops timers and the request in flight; the queue stays on disk and resumes at the next start. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.abortController.abort();
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    await this.transitionChain;
    await this.persist();
  }

  /** Runs the queue until nothing is due (tests drive it directly; the timer calls it in production). */
  async drain(): Promise<void> {
    if (this.draining || this.shuttingDown || !this.loaded) {
      return;
    }
    this.draining = true;
    try {
      for (let task = this.nextDueTask(); task && !this.shuttingDown; task = this.nextDueTask()) {
        await this.runTask(task);
      }
    } finally {
      this.draining = false;
    }
    this.scheduleNextDrain();
  }

  // --- recording lifecycle -------------------------------------------------

  private async applyTransition(
    transition: Exclude<RecordingTransitionT, { type: "progress" }>,
    elapsedSeconds: number | null,
  ): Promise<void> {
    const running = this.records.filter((record) => record.state === "recording");
    if (transition.type === "stopped") {
      for (const record of running) {
        await this.finishRecording(record, transition.lastError, elapsedSeconds);
      }
      await this.persist();
      return;
    }
    // A leftover record means its stop was never seen: settle it before the new recording.
    for (const record of running) {
      await this.finishRecording(record, null, null);
    }
    const now = this.now();
    this.records.push({
      id: randomUUID(),
      file_path: transition.filePath,
      size_bytes: 0,
      mtime_ms: 0,
      codec: transition.codec,
      container: meetingRecordingContainer(transition.codec),
      width: transition.programFormat.width,
      height: transition.programFormat.height,
      fps: transition.programFormat.fps,
      duration_ms: 0,
      recorded_at_ms: now,
      enqueued_at_ms: 0,
      state: "recording",
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
      updated_at_ms: now,
    });
    await this.persist();
  }

  /**
   * Settles a recording that is over: it becomes an upload task or is
   * dropped (with the reason the user is shown, if any).
   */
  private async finishRecording(
    record: RecordingUploadRecordT,
    lastError: string | null,
    elapsedSeconds: number | null,
  ): Promise<void> {
    const stat = await fs.stat(record.file_path).catch(() => null);
    const partExists = await fs.access(`${record.file_path}${PART_SUFFIX}`).then(
      () => true,
      () => false,
    );
    const decision = decideFinishedRecording({
      enabled: this.settings.enabled,
      codec: record.codec,
      lastError,
      fileSizeBytes: stat?.isFile() ? stat.size : null,
      partExists,
    });
    const now = this.now();
    const fileName = path.basename(record.file_path);
    if (decision.action === "drop" || !stat) {
      this.records = this.records.filter((candidate) => candidate !== record);
      if (decision.action === "drop" && decision.reason) {
        this.lastSkipped = { file_name: fileName, at: now, reason: decision.reason };
        this.deps.logger.info(`[RecordingUpload] Not uploading ${fileName}: ${decision.reason}`);
        this.publishNow();
      }
      return;
    }
    const durationMs =
      elapsedSeconds !== null ? elapsedSeconds * 1000 : Math.max(0, stat.mtimeMs - record.recorded_at_ms);
    record.state = "queued";
    record.size_bytes = stat.size;
    record.mtime_ms = stat.mtimeMs;
    record.duration_ms = Math.min(MAX_DURATION_MS, Math.round(durationMs));
    record.enqueued_at_ms = now;
    record.next_attempt_at = now;
    record.updated_at_ms = now;
    this.deps.logger.info(`[RecordingUpload] Queued ${fileName} (${stat.size} bytes)`);
    this.publishNow();
    this.scheduleDrain(0);
  }

  // --- queue ---------------------------------------------------------------

  private pendingTasks(): RecordingUploadRecordT[] {
    return this.records
      .filter((record) => record.state !== "recording" && !isTerminal(record))
      .sort((a, b) => a.enqueued_at_ms - b.enqueued_at_ms);
  }

  private nextDueTask(): RecordingUploadRecordT | undefined {
    const now = this.now();
    return this.pendingTasks().find((record) => record.next_attempt_at <= now);
  }

  private scheduleNextDrain(): void {
    const pending = this.pendingTasks();
    if (pending.length === 0) {
      return;
    }
    const nextAt = Math.min(...pending.map((record) => record.next_attempt_at));
    this.scheduleDrain(Math.max(0, nextAt - this.now()));
  }

  private scheduleDrain(delayMs: number): void {
    if (this.shuttingDown) {
      return;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
    }
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      void this.drain();
    }, Math.min(delayMs, MAX_DRAIN_TIMER_MS));
    this.drainTimer.unref?.();
  }

  private async runTask(task: RecordingUploadRecordT): Promise<void> {
    try {
      await this.processTask(task);
    } catch (error) {
      if (this.shuttingDown || isAbortError(error)) {
        return;
      }
      await this.handleTaskError(task, error);
    } finally {
      this.liveProgress = null;
    }
  }

  private async processTask(task: RecordingUploadRecordT): Promise<void> {
    if (this.now() - task.enqueued_at_ms > MAX_TASK_AGE_MS) {
      throw new TerminalTaskError("upload_expired");
    }
    await this.assertFileUnchanged(task);
    if (task.state === "completing" && task.recording_id && task.sha256) {
      // The bytes are on the server; only the registration is missing.
      await this.complete(task);
      return;
    }
    const issued = await this.begin(task);
    if (!issued) {
      return;
    }
    if (!task.sha256) {
      await this.setState(task, "hashing");
      task.sha256 = await this.hashFile(task.file_path);
    }
    await this.setState(task, "uploading");
    const uploaded = await this.upload(task, issued);
    if (!uploaded) {
      return;
    }
    await this.setState(task, "completing");
    await this.complete(task);
  }

  /**
   * Asks the platform for (a fresh token of) the upload. Returns null when
   * the platform already holds the complete recording: the task is done.
   */
  private async begin(task: RecordingUploadRecordT): Promise<IssuedGrantT | null> {
    if (!isUploadableRecordingCodec(task.codec)) {
      throw new TerminalTaskError("codec_not_uploadable");
    }
    if (task.size_bytes > MAX_RECORDING_BYTES) {
      throw new TerminalTaskError("recording_too_large");
    }
    const issuedAtMs = this.now();
    const grant = await this.deps.platform.begin({
      client_recording_id: task.id,
      file_name: platformFileName(task.file_path),
      size_bytes: task.size_bytes,
      codec: task.codec,
      container: task.container,
      width: task.width,
      height: task.height,
      fps: task.fps,
      duration_ms: task.duration_ms,
      recorded_at_ms: task.recorded_at_ms,
      bytes_uploaded: task.bytes_uploaded,
    });
    task.recording_id = grant.recording_id;
    if (grant.state === "ready") {
      await this.finishTask(task, "done", null);
      return null;
    }
    return { grant, issuedAtMs };
  }

  /**
   * Moves the bytes. Resumes at the server's offset, replaces the token
   * shortly before it expires and after the server refused it, and starts a
   * new upload from byte 0 when the server no longer knows the upload URL or
   * no longer accepts a token on it (a bounded number of times).
   *
   * @returns false when the platform reported the recording as complete meanwhile.
   */
  private async upload(task: RecordingUploadRecordT, first: IssuedGrantT): Promise<boolean> {
    const { tus } = this.deps;
    const signal = this.abortController.signal;
    let { grant, issuedAtMs } = first;
    let confirmedAtMs = issuedAtMs;
    const endpoint = parseTusEndpoint(grant.tus_endpoint, tus.urlTransport);

    const createUpload = async (): Promise<number> => {
      if (task.bytes_uploaded > 0) {
        if (task.upload_restarts >= MAX_UPLOAD_RESTARTS) {
          throw new TerminalTaskError("upload_restarts_exhausted");
        }
        task.upload_restarts += 1;
        this.deps.logger.warn(
          `[RecordingUpload] ${path.basename(task.file_path)}: the storage no longer continues the upload; starting again from byte 0 (${task.upload_restarts}/${MAX_UPLOAD_RESTARTS})`,
        );
      }
      task.upload_url = await tus.create({
        endpoint: grant.tus_endpoint,
        token: grant.token,
        sizeBytes: task.size_bytes,
        bucket: grant.bucket,
        objectName: grant.storage_path,
        contentType: grant.content_type,
        signal,
      });
      task.bytes_uploaded = 0;
      await this.touch(task);
      return 0;
    };
    const resumeOffset = async (): Promise<number> => {
      if (!task.upload_url || new URL(task.upload_url).origin !== endpoint.origin) {
        return createUpload();
      }
      try {
        const offset = await tus.getOffset({ uploadUrl: task.upload_url, token: grant.token, signal });
        return offset <= task.size_bytes ? offset : await createUpload();
      } catch (error) {
        if (isTusUploadGone(error) || isTusTokenRefusal(error)) {
          return createUpload();
        }
        throw error;
      }
    };
    const refreshGrant = async (): Promise<boolean> => {
      const next = await this.begin(task);
      if (!next) {
        return false;
      }
      ({ grant, issuedAtMs } = next);
      confirmedAtMs = issuedAtMs;
      return true;
    };
    const tokenExpiresSoon = (): boolean => {
      const lifetimeMs = grant.token_ttl_s * 1000;
      return this.now() - issuedAtMs > lifetimeMs - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetimeMs / 2);
    };

    let offset = await resumeOffset();
    let recoveries = 0;
    while (offset < task.size_bytes) {
      // Shutdown between two chunks: stop here, the next start resumes at this offset.
      signal.throwIfAborted();
      if (tokenExpiresSoon() && !(await refreshGrant())) {
        return false;
      }
      const chunkStart = offset;
      const length = Math.min(grant.chunk_size_bytes, task.size_bytes - chunkStart);
      if (chunkStart + length === task.size_bytes && this.now() - confirmedAtMs > FINAL_CHUNK_CONFIRM_AGE_MS) {
        // The storage creates the object with the last chunk. A recording the
        // user deleted meanwhile must not reach that point: begin refuses it
        // (the task ends as cancelled). Its token is not needed; the one in
        // use is kept so the storage sees no change of token on this upload.
        if (!(await this.begin(task))) {
          return false;
        }
        confirmedAtMs = this.now();
      }
      try {
        offset = await tus.patchChunk({
          uploadUrl: task.upload_url ?? "",
          token: grant.token,
          filePath: task.file_path,
          offset: chunkStart,
          length,
          signal,
          onBytesSent: (sent) => {
            this.liveProgress = { id: task.id, bytes: chunkStart + sent };
            this.publishProgress();
          },
        });
      } catch (error) {
        recoveries += 1;
        if (isAbortError(error) || recoveries > MAX_RECOVERIES_WITHOUT_PROGRESS) {
          throw error;
        }
        if (isTusOffsetConflict(error)) {
          offset = await resumeOffset();
        } else if (isTusTokenRefusal(error)) {
          if (!(await refreshGrant())) {
            return false;
          }
          offset = await resumeOffset();
        } else if (isTusUploadGone(error)) {
          offset = await createUpload();
        } else {
          throw error;
        }
        continue;
      }
      recoveries = 0;
      task.bytes_uploaded = offset;
      task.attempts = 0;
      task.answered_attempts = 0;
      task.error_code = null;
      await this.touch(task);
      this.publishProgress();
    }
    task.bytes_uploaded = offset;
    return true;
  }

  private async complete(task: RecordingUploadRecordT): Promise<void> {
    await this.assertFileUnchanged(task);
    const request = { recording_id: task.recording_id ?? "", size_bytes: task.size_bytes, sha256: task.sha256 ?? "" };
    try {
      await this.deps.platform.complete(request);
    } catch (error) {
      if (!isRecordingRowClosed(error)) {
        throw error;
      }
      // The platform closed the row while the bridge was away (stalled
      // upload); the bytes are in storage. Begin reopens the row, then the
      // registration is tried once more. A second refusal ends the task.
      if (!(await this.begin(task))) {
        return;
      }
      await this.deps.platform.complete(request);
    }
    task.bytes_uploaded = task.size_bytes;
    await this.finishTask(task, "done", null);
  }

  private async handleTaskError(task: RecordingUploadRecordT, error: unknown): Promise<void> {
    if (error instanceof TerminalTaskError) {
      await this.failTask(task, error.code);
      return;
    }
    const reaction = classifyRecordingUploadError(error);
    if (reaction.kind === "cancel") {
      if (reaction.disableUpload && this.settings.enabled) {
        this.settings = { enabled: false, updated_at_ms: this.now() };
        await this.deps.settingsStore.save(this.settings);
      }
      await this.finishTask(task, "cancelled", reaction.errorCode);
      if (reaction.abortRow) {
        await this.abortOnPlatform(task, reaction.errorCode);
      }
      return;
    }
    if (reaction.kind === "fail" || (reaction.kind === "restart" && task.restarted)) {
      await this.failTask(task, reaction.errorCode);
      return;
    }
    if (reaction.kind === "restart") {
      task.restarted = true;
      task.upload_url = null;
      task.bytes_uploaded = 0;
      task.attempts = 0;
      task.answered_attempts = 0;
      task.error_code = reaction.errorCode;
      task.next_attempt_at = this.now();
      await this.setState(task, "queued");
      return;
    }
    task.attempts += 1;
    if (isAnsweredFailure(error)) {
      task.answered_attempts += 1;
      if (task.answered_attempts >= this.maxTaskAttempts) {
        await this.failTask(task, "upload_retries_exhausted");
        return;
      }
    }
    task.error_code =
      error instanceof RecordingFileUnavailableError ? "file_unavailable" : describeTransientUploadError(error);
    task.next_attempt_at =
      this.now() +
      computeBackoffDelayMs({
        attempt: task.attempts,
        baseMs: this.retryBaseMs,
        maxMs: this.retryMaxMs,
        jitterRatio: RETRY_JITTER_RATIO,
      });
    this.deps.logger.warn(
      `[RecordingUpload] ${path.basename(task.file_path)}: attempt ${task.attempts} failed (${task.error_code}); retrying later`,
    );
    // A half-computed hash is not kept: the next attempt hashes again.
    await this.setState(task, task.state === "hashing" ? "queued" : task.state);
  }

  /** Ends a task as `failed` and tells the platform. */
  private async failTask(task: RecordingUploadRecordT, errorCode: string): Promise<void> {
    await this.finishTask(task, "failed", errorCode);
    await this.abortOnPlatform(task, errorCode);
  }

  /** Closes the platform's row of an upload that will not finish, best effort, so it does not wait for the stall timeout. */
  private async abortOnPlatform(task: RecordingUploadRecordT, errorCode: string): Promise<void> {
    if (!task.recording_id) {
      return;
    }
    try {
      await this.deps.platform.abort({ recording_id: task.recording_id, error_code: errorCode });
    } catch {
      // Best effort: the platform's maintenance marks a stalled upload on its own.
    }
  }

  private async finishTask(
    task: RecordingUploadRecordT,
    state: (typeof RECORDING_UPLOAD_TERMINAL_STATES)[number],
    errorCode: string | null,
  ): Promise<void> {
    task.upload_url = null;
    task.error_code = errorCode;
    task.next_attempt_at = 0;
    const fileName = path.basename(task.file_path);
    if (state === "done") {
      this.deps.logger.info(`[RecordingUpload] Uploaded ${fileName} (${task.size_bytes} bytes)`);
    } else {
      this.deps.logger.warn(`[RecordingUpload] Upload of ${fileName} ${state}: ${errorCode}`);
    }
    await this.setState(task, state);
    this.pruneTerminalRecords();
    await this.persist();
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * The file must still be the one that was enqueued: same size, same
   * modification time. It is missing for good only when its folder is there
   * and it is not; anything else (the volume or share is not there, a
   * permission or I/O error) may heal and is retried until the age limit.
   */
  private async assertFileUnchanged(task: RecordingUploadRecordT): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(task.file_path);
    } catch (error) {
      const folder = await fs.stat(path.dirname(task.file_path)).catch(() => null);
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && folder?.isDirectory()) {
        throw new TerminalTaskError("file_missing");
      }
      throw new RecordingFileUnavailableError();
    }
    if (!stat.isFile()) {
      throw new TerminalTaskError("file_missing");
    }
    if (stat.size !== task.size_bytes || stat.mtimeMs !== task.mtime_ms) {
      throw new TerminalTaskError("file_changed");
    }
  }

  /** sha256 of the whole file, streamed (read-only, bounded memory). */
  private async hashFile(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath, {
      flags: "r",
      highWaterMark: HASH_READ_BYTES,
      signal: this.abortController.signal,
    });
    for await (const chunk of stream) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  }

  private async setState(task: RecordingUploadRecordT, state: RecordingUploadRecordT["state"]): Promise<void> {
    task.state = state;
    await this.touch(task);
    this.publishNow();
  }

  private async touch(task: RecordingUploadRecordT): Promise<void> {
    task.updated_at_ms = this.now();
    await this.persist();
  }

  private async persist(): Promise<void> {
    if (this.loaded) {
      await this.deps.queueStore.save(this.records);
    }
  }

  /** Terminal records are kept for a while so the web app can show the outcome, then dropped. */
  private pruneTerminalRecords(): void {
    const cutoff = this.now() - TERMINAL_RETENTION_MS;
    const keptTerminal = new Set(
      this.records
        .filter((record) => isTerminal(record) && record.updated_at_ms >= cutoff)
        .sort((a, b) => b.updated_at_ms - a.updated_at_ms)
        .slice(0, MAX_TERMINAL_RECORDS),
    );
    this.records = this.records.filter((record) => !isTerminal(record) || keptTerminal.has(record));
  }

  private publishNow(): void {
    if (this.progressTimer) {
      clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
    this.lastPublishedAt = this.now();
    this.deps.publish(this.getStatus());
  }

  /** Progress reaches the web app at most every PROGRESS_PUBLISH_INTERVAL_MS (trailing edge included). */
  private publishProgress(): void {
    const waitMs = this.lastPublishedAt + PROGRESS_PUBLISH_INTERVAL_MS - this.now();
    if (waitMs <= 0) {
      this.publishNow();
      return;
    }
    if (this.progressTimer || this.shuttingDown) {
      return;
    }
    this.progressTimer = setTimeout(() => {
      this.progressTimer = null;
      this.publishNow();
    }, waitMs);
    this.progressTimer.unref?.();
  }
}
