import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";

import type { MeetingRecordingCodecT } from "@broadify/protocol";

/** Helper mode that prints the hardware video encoders as one JSON line. */
export const MEETING_RECORDING_PROBE_ARG = "--probe-recording";
/**
 * Upper bound for the probe process. The probe only reads the platform's
 * encoder registry (about a second cold on macOS); a helper that takes longer
 * is treated as failed instead of holding up `get_status`.
 */
export const MEETING_RECORDING_PROBE_TIMEOUT_MS = 5000;
const MEETING_RECORDING_PROBE_MAX_OUTPUT_BYTES = 64 * 1024;

const MEETING_RECORDING_CODECS = [
  "h264",
  "hevc",
  "prores_422_lt",
  "prores_422",
  "prores_422_hq",
] as const satisfies readonly MeetingRecordingCodecT[];

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

export type MeetingRecordingProbeOutcomeT =
  | { ok: true; probe: MeetingRecordingProbeT }
  | { ok: false; reason: MeetingRecordingProbeFailureT };

type ProbeExecErrorT = Error & { killed?: boolean };

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
            // execFile kills the child when the timeout elapses.
            resolve({
              ok: false,
              reason: error.killed ? "timeout" : "spawn_failed",
            });
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
