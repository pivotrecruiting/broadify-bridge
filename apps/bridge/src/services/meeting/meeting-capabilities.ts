import type {
  MeetingCapabilitiesT,
  MeetingProgramFormatT,
  MeetingRecordingCodecT,
} from "@broadify/protocol";

import {
  MEETING_RECORDING_CODECS,
  meetingRecordingContainer,
} from "./meeting-recording-codecs.js";
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

type MeetingProgramFormatLimitsT = NonNullable<
  MeetingCapabilitiesT["program_formats"]
>;

/**
 * Program formats `meeting_engine_start` accepts (ADR-0010), the same on
 * every platform for now. Deliberately the verified envelope, not what the
 * helper would technically start with: 1080p is the size the Windows camera
 * is capped at and the virtual camera is built for, and both rates stay
 * within the Windows camera's 30 fps cap. 4K and 50/60 fps are added here
 * once they have been measured on a device.
 */
export const MEETING_PROGRAM_FORMAT_LIMITS: MeetingProgramFormatLimitsT = {
  max_width: 1920,
  max_height: 1080,
  fps: [25, 30],
};

/**
 * Codecs the meeting recorder of each platform can write (a platform without
 * an entry has no recorder). The single list to extend when a recorder
 * learns a codec: a codec is advertised only if it is listed here AND the
 * machine has a hardware encoder for it. macOS writes every codec of the
 * contract (AVAssetWriter); Windows writes H.264 only, and never ProRes -
 * there is no licensed encoder for it. The container follows from the codec
 * (`MEETING_RECORDING_CODEC_FORMATS`).
 */
export const MEETING_RECORDER_SUPPORTED_CODECS: Readonly<
  Partial<Record<NodeJS.Platform, readonly MeetingRecordingCodecT[]>>
> = {
  darwin: MEETING_RECORDING_CODECS,
  win32: ["h264"],
};

type MeetingCapabilityDepsT = {
  platform?: NodeJS.Platform;
  /**
   * Result of the helper's encoder probe
   * (`MeetingHelperManager.getRecordingProbe`); null while it is unknown.
   */
  recordingProbe?: MeetingRecordingProbeT | null;
};

/**
 * Recording capability for a probe result: the platform recorder's codecs
 * for which the machine has a hardware encoder (hardware only, no software
 * fallback - ADR-0010), each up to the largest program format. No codec has
 * a limit of its own yet: every one records whatever `program_formats`
 * allows.
 */
function resolveRecordingCapability(
  probe: MeetingRecordingProbeT,
  platform: NodeJS.Platform,
): NonNullable<MeetingCapabilitiesT["recording"]> {
  const hardwareCodecs = new Set(probe.encoders.map((encoder) => encoder.codec));
  return {
    codecs: (MEETING_RECORDER_SUPPORTED_CODECS[platform] ?? [])
      .filter((codec) => hardwareCodecs.has(codec))
      .map((codec) => ({
        codec,
        container: meetingRecordingContainer(codec),
        max_height: MEETING_PROGRAM_FORMAT_LIMITS.max_height,
        max_fps: Math.max(...MEETING_PROGRAM_FORMAT_LIMITS.fps),
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
 * `program_formats` bounds what `meeting_engine_start` accepts (ADR-0010).
 *
 * `recording` is derived from the helper's hardware-encoder probe and is
 * left out while that result is unknown (probe not finished, failed or timed
 * out): the web app treats the missing field as "no recording format choice".
 */
export function getMeetingCapabilities(
  deps: MeetingCapabilityDepsT = {},
): MeetingCapabilitiesT {
  const { platform = process.platform, recordingProbe = null } = deps;
  return {
    program_portrait: platform === "darwin",
    layer_canvas: true,
    program_formats: {
      ...MEETING_PROGRAM_FORMAT_LIMITS,
      fps: [...MEETING_PROGRAM_FORMAT_LIMITS.fps],
    },
    ...(recordingProbe
      ? { recording: resolveRecordingCapability(recordingProbe, platform) }
      : {}),
  };
}

/**
 * Whether a recording may be started with an explicitly requested codec: only
 * with one the capability block advertises. Without the block (probe unknown)
 * no codec may be requested - the web app sends one only when it is reported.
 */
export function isAdvertisedRecordingCodec(
  capabilities: MeetingCapabilitiesT,
  codec: MeetingRecordingCodecT,
): boolean {
  return (
    capabilities.recording?.codecs.some((entry) => entry.codec === codec) ??
    false
  );
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
 * Whether a program format is within the advertised limits. The limits bound
 * a landscape canvas; a portrait canvas is measured with its edges swapped
 * (whether portrait is allowed at all is `program_portrait`).
 */
export function isSupportedProgramFormat(
  format: MeetingProgramFormatT,
  limits: MeetingProgramFormatLimitsT = MEETING_PROGRAM_FORMAT_LIMITS,
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
