import type {
  MeetingCapabilitiesT,
  MeetingProgramFormatT,
} from "@broadify/protocol";

/** Engine geometry used when `meeting_engine_start` omits a field. */
export const DEFAULT_MEETING_PROGRAM_FORMAT: MeetingProgramFormatT = {
  width: 1920,
  height: 1080,
  fps: 30,
};

export const MEETING_PROGRAM_PORTRAIT_UNSUPPORTED_CODE =
  "meeting_program_portrait_unsupported";
export const MEETING_ENGINE_RESTART_REQUIRED_CODE =
  "meeting_engine_restart_required";

type MeetingCapabilityDepsT = { platform: NodeJS.Platform };

const defaultDeps: MeetingCapabilityDepsT = { platform: process.platform };

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
 */
export function getMeetingCapabilities(
  deps: MeetingCapabilityDepsT = defaultDeps,
): MeetingCapabilitiesT {
  return { program_portrait: deps.platform === "darwin", layer_canvas: true };
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

export function isSameProgramGeometry(
  a: { width: number; height: number },
  b: { width: number; height: number },
): boolean {
  return a.width === b.width && a.height === b.height;
}
