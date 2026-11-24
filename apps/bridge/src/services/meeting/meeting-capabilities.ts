import type {
  MeetingCapabilitiesT,
  MeetingProgramFormatT,
  MeetingRecordingCodecT,
} from "@broadify/protocol";

import { meetingRecordingContainer } from "./meeting-recording-codecs.js";
import type { MeetingRecordingProbeT } from "./meeting-recording-probe.js";

/** Engine geometry used when `meeting_engine_start` omits a field. */
export const DEFAULT_MEETING_PROGRAM_FORMAT: MeetingProgramFormatT = {
  width: 1920,
  height: 1080,
  fps: 30,
};

export const MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE =
  "meeting_program_portrait_unsupported";
export const MEETING_PROGRAM_FORMAT_UNSUPPORTED_CODE =
  "meeting_program_format_unsupported";
export const MEETING_ENGINE_RESTART_REQUIRED_CODE =
  "meeting_engine_restart_required";
export const MEETING_RECORDING_CODEC_UNSUPPORTED_CODE =
  "meeting_recording_codec_unsupported";
export const MEETING_KEYER_FPS_UNSUPPORTED_CODE = "meeting_keyer_fps_unsupported";

type MeetingProgramFormatLimitsT = NonNullable<
  MeetingCapabilitiesT["program_formats"]
>;

/**
 * Program formats `meeting_engine_start` accepts on a platform without an
 * entry in `MEETING_PROGRAM_FORMAT_LIMITS` (ADR-0010). Deliberately the
 * verified envelope, not what the helper would technically start with: 1080p
 * is the size the Windows camera is capped at and the virtual camera is built
 * for, and both rates stay within the Windows camera's 30 fps cap.
 *
 * `keyer_max_fps` is the highest program frame rate keying runs at, the one
 * place to raise when a keyer holds more. Measured on an M1 Pro (ADR-0010):
 * one keyer run takes about 22 ms, so a 60 fps program reaches about 31
 * ticks per second with the keyer and 59.97 without it.
 */
const BASE_MEETING_PROGRAM_FORMAT_LIMITS: MeetingProgramFormatLimitsT = {
  max_width: 1920,
  max_height: 1080,
  fps: [25, 30],
  keyer_max_fps: 30,
};

/**
 * Platforms whose program formats go beyond the base envelope. macOS runs
 * the program (and therefore the recording) at 50 and 60 fps as well; the
 * virtual camera and the previews get every second frame of those (ADR-0010).
 * Windows stays on the base envelope until 50/60 fps have been measured on a
 * device; 4K is added here once it has been measured.
 */
export const MEETING_PROGRAM_FORMAT_LIMITS: Readonly<
  Partial<Record<NodeJS.Platform, MeetingProgramFormatLimitsT>>
> = {
  darwin: { ...BASE_MEETING_PROGRAM_FORMAT_LIMITS, fps: [25, 30, 50, 60] },
};

/** The program formats of a platform, as a copy the caller may hand out. */
export function getMeetingProgramFormatLimits(
  platform: NodeJS.Platform = process.platform,
): MeetingProgramFormatLimitsT {
  const limits =
    MEETING_PROGRAM_FORMAT_LIMITS[platform] ?? BASE_MEETING_PROGRAM_FORMAT_LIMITS;
  return { ...limits, fps: [...limits.fps] };
}

/**
 * Codecs the meeting recorder of each platform can write (a platform without
 * an entry has no recorder). The single list to extend when a recorder
 * learns a codec: a codec is advertised only if it is listed here AND the
 * machine has a hardware encoder for it. Each platform spells its codecs
 * out, so a codec added to the contract is advertised nowhere until its
 * writer exists. macOS writes H.264, HEVC and ProRes 422 LT / 422 / HQ
 * (AVAssetWriter); Windows writes H.264 only, and never ProRes - there is no
 * licensed encoder for it. The container follows from the codec
 * (`MEETING_RECORDING_CODEC_FORMATS`).
 */
export const MEETING_RECORDER_SUPPORTED_CODECS: Readonly<
  Partial<Record<NodeJS.Platform, readonly MeetingRecordingCodecT[]>>
> = {
  darwin: ["h264", "hevc", "prores_422_lt", "prores_422", "prores_422_hq"],
  win32: ["h264"],
};

/**
 * Highest program frame rate each platform recorder writes per codec
 * (ADR-0010); a codec without an entry records every rate of the platform.
 * The one place to lower when a device measurement shows that a codec does
 * not hold a rate: the capability then reports the lower `max_fps` and the
 * recording gate refuses that codec for a faster program.
 */
export const MEETING_RECORDER_CODEC_MAX_FPS: Readonly<
  Partial<
    Record<NodeJS.Platform, Readonly<Partial<Record<MeetingRecordingCodecT, number>>>>
  >
> = {
  darwin: {
    h264: 60,
    hevc: 60,
    prores_422_lt: 60,
    prores_422: 60,
    prores_422_hq: 60,
  },
  win32: { h264: 30 },
};

/** State of the helper's encoder probe, as `recording_probe` reports it. */
export type MeetingRecordingProbeStateT = NonNullable<
  MeetingCapabilitiesT["recording_probe"]
>;

/** Why a requested recording codec cannot be recorded right now. */
export type MeetingRecordingCodecRefusalReasonT =
  | "encoder_unavailable"
  | "program_format_exceeded"
  | "encoders_unknown";

type MeetingCapabilityDepsT = {
  platform?: NodeJS.Platform;
  /**
   * Result of the helper's encoder probe
   * (`MeetingHelperManager.getRecordingProbe`); null while it is unknown.
   */
  recordingProbe?: MeetingRecordingProbeT | null;
  /**
   * Why there is no result (`MeetingHelperManager.getRecordingProbeState`):
   * still `pending` or `failed` for this bridge run. Not read when
   * `recordingProbe` is given - a result is always `done`.
   */
  recordingProbeState?: MeetingRecordingProbeStateT;
};

/**
 * Recording capability for a probe result: the platform recorder's codecs
 * for which the machine has a hardware encoder (hardware only, no software
 * fallback - ADR-0010). Each records the largest program size of the
 * platform, at up to the platform's highest frame rate or the codec's own
 * cap (`MEETING_RECORDER_CODEC_MAX_FPS`), whichever is lower.
 */
function resolveRecordingCapability(
  probe: MeetingRecordingProbeT,
  platform: NodeJS.Platform,
): NonNullable<MeetingCapabilitiesT["recording"]> {
  const hardwareCodecs = new Set(probe.encoders.map((encoder) => encoder.codec));
  const limits = getMeetingProgramFormatLimits(platform);
  const platformMaxFps = Math.max(...limits.fps);
  const codecMaxFps = MEETING_RECORDER_CODEC_MAX_FPS[platform] ?? {};
  return {
    codecs: (MEETING_RECORDER_SUPPORTED_CODECS[platform] ?? [])
      .filter((codec) => hardwareCodecs.has(codec))
      .map((codec) => ({
        codec,
        container: meetingRecordingContainer(codec),
        max_height: limits.max_height,
        max_fps: Math.min(platformMaxFps, codecMaxFps[codec] ?? platformMaxFps),
      })),
    upload_copy: false,
  };
}

/**
 * Capability block for `get_status.capabilities.meeting`.
 *
 * `program_portrait` says whether this bridge version and platform can run the
 * meeting program on a portrait canvas (ADR-0007). macOS only for now: the
 * Windows helper carries the same code, but it has not been verified on a
 * device yet, so the flag stays false there until it has.
 *
 * `layer_canvas` says that `graphics_send` honours the per-layer `canvas`
 * (ADR-0007). It is a feature of the graphics renderer, which is the same on
 * every platform, so it does not depend on `program_portrait`.
 *
 * `program_formats` bounds what `meeting_engine_start` accepts (ADR-0010),
 * and with `keyer_max_fps` the program frame rate keying may be turned on at.
 *
 * `recording_probe` is the state of the helper's hardware-encoder probe and
 * `recording` its result: present exactly when the state is `done`. While
 * the probe is `pending` (not started, running, or about to be retried) or
 * has `failed` for this bridge run, `recording` is left out. A platform
 * without a recorder needs no probe: it reports `done` with an empty list.
 */
export function getMeetingCapabilities(
  deps: MeetingCapabilityDepsT = {},
): MeetingCapabilitiesT {
  const {
    platform = process.platform,
    recordingProbe = null,
    recordingProbeState = "pending",
  } = deps;
  const recording = !MEETING_RECORDER_SUPPORTED_CODECS[platform]
    ? { codecs: [], upload_copy: false }
    : recordingProbe
      ? resolveRecordingCapability(recordingProbe, platform)
      : null;
  return {
    program_portrait: platform === "darwin",
    layer_canvas: true,
    program_formats: getMeetingProgramFormatLimits(platform),
    recording_probe: recording ? "done" : recordingProbeState,
    ...(recording ? { recording } : {}),
  };
}

export type MeetingRecordingCodecCheckT =
  | { ok: true; codec: MeetingRecordingCodecT }
  | { ok: false; reason: MeetingRecordingCodecRefusalReasonT };

/**
 * Whether a recording with an explicitly requested codec may start, and why
 * not otherwise. The codec has to be advertised (`capabilities.recording`,
 * which excludes every name outside the contract) and has to cover the
 * running program: its shorter edge and its frame rate. Without a running
 * program (`programFormat` null) only the name is checked. Without the
 * capability block the encoders are unknown and no codec may be requested.
 */
export function checkRequestedRecordingCodec(
  capabilities: MeetingCapabilitiesT,
  codec: string,
  programFormat: MeetingProgramFormatT | null,
): MeetingRecordingCodecCheckT {
  if (!capabilities.recording) {
    return { ok: false, reason: "encoders_unknown" };
  }
  const entry = capabilities.recording.codecs.find(
    (candidate) => candidate.codec === codec,
  );
  if (!entry) {
    return { ok: false, reason: "encoder_unavailable" };
  }
  if (
    programFormat &&
    (Math.min(programFormat.width, programFormat.height) > entry.max_height ||
      programFormat.fps > entry.max_fps)
  ) {
    return { ok: false, reason: "program_format_exceeded" };
  }
  return { ok: true, codec: entry.codec };
}

/** A program frame rate above the one keying runs at, as the refusal reports it. */
export type MeetingKeyerFpsExcessT = {
  program_fps: number;
  keyer_max_fps: number;
};

/**
 * The arbiter for keying and the program frame rate (ADR-0010): the excess
 * when a program of this format runs faster than keying does
 * (`program_formats.keyer_max_fps`), null when keying may be on. No running
 * program (`programFormat` null) and limits without `keyer_max_fps` have
 * nothing to exceed.
 */
export function findKeyerFpsExcess(
  programFormat: MeetingProgramFormatT | null,
  limits: MeetingProgramFormatLimitsT | undefined,
): MeetingKeyerFpsExcessT | null {
  const keyerMaxFps = limits?.keyer_max_fps;
  if (!programFormat || keyerMaxFps === undefined || programFormat.fps <= keyerMaxFps) {
    return null;
  }
  return { program_fps: programFormat.fps, keyer_max_fps: keyerMaxFps };
}

/** Fills the engine defaults into a (partial) start payload. */
export function resolveMeetingProgramFormat(options: {
  width?: number;
  height?: number;
  fps?: number;
}): MeetingProgramFormatT {
  return {
    width: options.width ?? DEFAULT_MEETING_PROGRAM_FORMAT.width,
    height: options.height ?? DEFAULT_MEETING_PROGRAM_FORMAT.height,
    fps: options.fps ?? DEFAULT_MEETING_PROGRAM_FORMAT.fps,
  };
}

export function isPortraitGeometry(size: {
  width: number;
  height: number;
}): boolean {
  return size.height > size.width;
}

/**
 * Whether a program format is within the limits, by default those advertised
 * on this platform. The limits bound a landscape canvas; a portrait canvas is
 * measured with its edges swapped (whether portrait is allowed at all is
 * `program_portrait`).
 */
export function isSupportedProgramFormat(
  format: MeetingProgramFormatT,
  limits: MeetingProgramFormatLimitsT = getMeetingProgramFormatLimits(),
): boolean {
  return (
    Math.max(format.width, format.height) <= limits.max_width &&
    Math.min(format.width, format.height) <= limits.max_height &&
    limits.fps.includes(format.fps)
  );
}

/**
 * Whether two program formats are the same engine: size and frame rate are
 * all fixed for the lifetime of the helper process, so a difference in any of
 * them needs a restart (ADR-0010).
 */
export function isSameProgramFormat(
  a: MeetingProgramFormatT,
  b: MeetingProgramFormatT,
): boolean {
  return a.width === b.width && a.height === b.height && a.fps === b.fps;
}
