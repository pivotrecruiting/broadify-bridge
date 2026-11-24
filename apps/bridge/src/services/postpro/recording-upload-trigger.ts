import type {
  MeetingProgramFormatT,
  MeetingRecordingCodecT,
  MeetingRecordingUploadSkipReasonT,
} from "@broadify/protocol";
import { isMeetingRecordingCodec } from "../meeting/meeting-recording-codecs.js";

const PART_SUFFIX = ".part";

/** Codecs whose recording is uploaded as it is; a ProRes master stays local (ADR-0011). */
export const UPLOADABLE_RECORDING_CODECS = ["h264", "hevc"] as const satisfies readonly MeetingRecordingCodecT[];
export type UploadableRecordingCodecT = (typeof UPLOADABLE_RECORDING_CODECS)[number];

export function isUploadableRecordingCodec(codec: MeetingRecordingCodecT): codec is UploadableRecordingCodecT {
  return (UPLOADABLE_RECORDING_CODECS as readonly string[]).includes(codec);
}

/**
 * What one meeting status says about the recorder, reduced to what the
 * recording upload needs. Pure projection, so the manager only calls one
 * function per published status (pattern: meeting-session-events.ts).
 */
export type RecordingUploadSummaryT = {
  active: boolean;
  /** Final path of the running or last recording (status path without `.part`); null without one. */
  filePath: string | null;
  codec: MeetingRecordingCodecT | null;
  /** `last_error` of the recorder; null when the status carries no recording object. */
  lastError: string | null;
  elapsedSeconds: number | null;
  programFormat: MeetingProgramFormatT | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : null;

const readProgramFormat = (value: unknown): MeetingProgramFormatT | null => {
  const format = asRecord(value);
  if (
    !format ||
    typeof format.width !== "number" ||
    typeof format.height !== "number" ||
    typeof format.fps !== "number"
  ) {
    return null;
  }
  return { width: format.width, height: format.height, fps: format.fps };
};

/**
 * Projects a meeting status. Returns null when the status does not say what
 * the recorder is doing: the helper is running but could not be asked
 * (`engineError`, or a status without the recording object while the engine
 * answers). Such a status must not look like a stopped recording - a stop
 * that is still finalizing blocks the helper's control thread, and a slow
 * answer is not a finished file. Without an engine there is no recorder: the
 * recording is over (engine stopped, helper exited or crashed).
 */
export function summarizeRecordingStatus(
  status: Record<string, unknown> | null | undefined,
): RecordingUploadSummaryT | null {
  if (!status || typeof status.engineError === "string") {
    return null;
  }
  const programFormat = readProgramFormat(status.program_format);
  const recording = asRecord(status.recording);
  if (!recording) {
    if (asRecord(status.engine)) {
      return null;
    }
    return { active: false, filePath: null, codec: null, lastError: null, elapsedSeconds: null, programFormat };
  }
  const rawPath = typeof recording.file_path === "string" ? recording.file_path : "";
  const filePath = rawPath.endsWith(PART_SUFFIX) ? rawPath.slice(0, -PART_SUFFIX.length) : rawPath;
  const codec = typeof recording.codec === "string" && isMeetingRecordingCodec(recording.codec) ? recording.codec : null;
  return {
    active: recording.active === true,
    filePath: filePath || null,
    codec,
    lastError: typeof recording.last_error === "string" ? recording.last_error : "",
    elapsedSeconds: typeof recording.elapsed_seconds === "number" ? recording.elapsed_seconds : null,
    programFormat,
  };
}

export type RecordingTransitionT =
  | { type: "started"; filePath: string; codec: MeetingRecordingCodecT; programFormat: MeetingProgramFormatT }
  | { type: "stopped"; lastError: string | null }
  | { type: "progress"; elapsedSeconds: number };

/**
 * Diff of two summaries. A recording that started without a usable path,
 * codec or program format yields no `started` (there is nothing the upload
 * could describe to the platform). Two different active files in a row are a
 * stop followed by a start.
 */
export function diffRecordingSummary(
  prev: RecordingUploadSummaryT | null,
  next: RecordingUploadSummaryT,
): RecordingTransitionT[] {
  const transitions: RecordingTransitionT[] = [];
  const wasActive = prev?.active ?? false;
  const fileChanged = wasActive && next.active && prev?.filePath !== next.filePath;
  if (wasActive && (!next.active || fileChanged)) {
    transitions.push({ type: "stopped", lastError: fileChanged ? null : next.lastError });
  }
  if (next.active && (!wasActive || fileChanged)) {
    if (next.filePath && next.codec && next.programFormat) {
      transitions.push({
        type: "started",
        filePath: next.filePath,
        codec: next.codec,
        programFormat: next.programFormat,
      });
    }
  }
  if (next.active && next.elapsedSeconds !== null) {
    transitions.push({ type: "progress", elapsedSeconds: next.elapsedSeconds });
  }
  return transitions;
}

export type FinishedRecordingFactsT = {
  /** The opt-in hint pushed by the web app. */
  enabled: boolean;
  codec: MeetingRecordingCodecT;
  /** Recorder error of the stop; null when the status carried no recording object (engine gone). */
  lastError: string | null;
  /** Size of the final file; null when it does not exist. */
  fileSizeBytes: number | null;
  /** A `<file>.part` sibling exists: the recorder did not finish the file. */
  partExists: boolean;
};

export type FinishedRecordingDecisionT =
  | { action: "enqueue" }
  /** `reason` null: dropped without telling the user (the upload is switched off). */
  | { action: "drop"; reason: MeetingRecordingUploadSkipReasonT | null };

/**
 * Whether a finished recording is enqueued for upload. Only a recording that
 * finished cleanly, exists completely under its final name and has an
 * uploadable codec is; everything else is dropped with the reason the user
 * is shown. Without the opt-in nothing is enqueued and nothing is reported.
 */
export function decideFinishedRecording(facts: FinishedRecordingFactsT): FinishedRecordingDecisionT {
  if (!facts.enabled) {
    return { action: "drop", reason: null };
  }
  if (facts.lastError) {
    return { action: "drop", reason: "recording_failed" };
  }
  if (facts.partExists) {
    return { action: "drop", reason: "file_incomplete" };
  }
  if (!facts.fileSizeBytes) {
    return { action: "drop", reason: "file_missing" };
  }
  if (!isUploadableRecordingCodec(facts.codec)) {
    return { action: "drop", reason: "prores_master_local" };
  }
  return { action: "enqueue" };
}
