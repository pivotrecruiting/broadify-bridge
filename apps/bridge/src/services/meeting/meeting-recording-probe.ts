import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";

import type { MeetingRecordingCodecT } from "@broadify/protocol";

import { MEETING_RECORDING_CODECS } from "./meeting-recording-codecs.js";

/** Helper mode that prints the hardware video encoders as one JSON line. */
export const MEETING_RECORDING_PROBE_ARG = "--probe-recording";
/**
 * Upper bound for the probe process. The probe only reads the platform's
 * encoder registry (about a second cold on macOS); a helper that takes longer
 * is treated as failed instead of holding up `get_status`.
 */
export const MEETING_RECORDING_PROBE_TIMEOUT_MS = 5000;
const MEETING_RECORDING_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;
/**
 * Probe runs per bridge run, the first one included. Only a transient failure
 * leads to another run, so a helper that keeps hanging costs a bounded number
 * of short-lived processes.
 */
export const MEETING_RECORDING_PROBE_MAX_ATTEMPTS = 3;
/** `error.code` of an `execFile` child that printed more than `maxBuffer`. */
const EXEC_MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * The `recording_probe` line of `meeting-helper --probe-recording`
 * (native/meeting-helper/src/recorder/recording_probe.h).
 */
const MeetingRecordingProbeLineSchema = z.object({
  type: z.literal("recording_probe"),
  backend: z.string().min(1).max(64),
  ok: z.boolean(),
  encoders: z
    .array(
      z.object({
        codec: z.enum(MEETING_RECORDING_CODECS),
        name: z.string().max(256),
        vendor: z.string().max(64).optional(),
      }),
    )
    .max(64),
});

/** Hardware video encoders of this machine, as the helper enumerated them. */
export type MeetingRecordingProbeT = {
  backend: string;
  encoders: Array<{
    codec: MeetingRecordingCodecT;
    name: string;
    vendor?: string;
  }>;
};

export type MeetingRecordingProbeFailureT =
  | "helper_missing"
  | "timeout"
  | "spawn_failed"
  | "invalid_output"
  | "enumeration_failed";

/**
 * Failures that say nothing about the machine's encoders and can pass on
 * their own: a helper that was slow to launch (cold start, virus scan) or
 * could not be launched at that moment. Every other failure is the same on
 * the next run.
 */
const TRANSIENT_MEETING_RECORDING_PROBE_FAILURES: ReadonlySet<MeetingRecordingProbeFailureT> =
  new Set(["timeout", "spawn_failed"]);

export function isTransientMeetingRecordingProbeFailure(
  reason: MeetingRecordingProbeFailureT,
): boolean {
  return TRANSIENT_MEETING_RECORDING_PROBE_FAILURES.has(reason);
}

export type MeetingRecordingProbeOutcomeT =
  | { ok: true; probe: MeetingRecordingProbeT }
  | { ok: false; reason: MeetingRecordingProbeFailureT };

type ProbeExecErrorT = Error & { killed?: boolean; code?: unknown };

/**
 * Reason for a helper run that `execFile` reports as failed. The output limit
 * is checked first: the child is killed for it as well, and a helper that
 * floods stdout is not one that was too slow.
 */
function classifyProbeExecError(
  error: ProbeExecErrorT,
): MeetingRecordingProbeFailureT {
  if (error.code === EXEC_MAX_BUFFER_ERROR_CODE) {
    return "invalid_output";
  }
  // execFile kills the child when the timeout elapses.
  return error.killed ? "timeout" : "spawn_failed";
}

type MeetingRecordingProbeDepsT = {
  helperExists: (helperPath: string) => boolean;
  execHelper: (
    helperPath: string,
    args: string[],
    options: { timeout: number; maxBuffer: number; windowsHide: boolean },
    callback: (error: ProbeExecErrorT | null, stdout: string) => void,
  ) => void;
};

const defaultDeps: MeetingRecordingProbeDepsT = {
  helperExists: existsSync,
  execHelper: (helperPath, args, options, callback) => {
    execFile(
      helperPath,
      args,
      { ...options, encoding: "utf8" },
      (error, stdout) => callback(error, stdout),
    );
  },
};

/**
 * Reads the probe line out of the helper's stdout. Other lines (helper events
 * that may precede it) are skipped; anything that is not the expected shape
 * is a failure, as is an enumeration the helper itself reports as failed
 * (`ok: false`: the encoder list is unknown, not empty).
 */
export function parseMeetingRecordingProbeOutput(
  stdout: string,
): MeetingRecordingProbeOutcomeT {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if ((candidate as { type?: unknown } | null)?.type !== "recording_probe") {
      continue;
    }
    const parsed = MeetingRecordingProbeLineSchema.safeParse(candidate);
    if (!parsed.success) {
      return { ok: false, reason: "invalid_output" };
    }
    if (!parsed.data.ok) {
      return { ok: false, reason: "enumeration_failed" };
    }
    return {
      ok: true,
      probe: { backend: parsed.data.backend, encoders: parsed.data.encoders },
    };
  }
  return { ok: false, reason: "invalid_output" };
}

/**
 * Runs the helper once in probe mode. Starts no engine and opens no device;
 * never rejects - every failure is an outcome with a stable reason.
 */
export function runMeetingRecordingProbe(
  helperPath: string,
  deps: MeetingRecordingProbeDepsT = defaultDeps,
): Promise<MeetingRecordingProbeOutcomeT> {
  if (!deps.helperExists(helperPath)) {
    return Promise.resolve({ ok: false, reason: "helper_missing" });
  }
  return new Promise((resolve) => {
    try {
      deps.execHelper(
        helperPath,
        [MEETING_RECORDING_PROBE_ARG],
        {
          timeout: MEETING_RECORDING_PROBE_TIMEOUT_MS,
          maxBuffer: MEETING_RECORDING_PROBE_MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            resolve({ ok: false, reason: classifyProbeExecError(error) });
            return;
          }
          resolve(parseMeetingRecordingProbeOutput(stdout));
        },
      );
    } catch {
      resolve({ ok: false, reason: "spawn_failed" });
    }
  });
}
