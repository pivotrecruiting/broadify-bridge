import type { SwitcherEventT } from "./session-log-types.js";

/**
 * Minimal structural view of the atem-connection 2.5 state we read. Kept
 * local so tests and replay fixtures do not need a live Atem instance.
 * (atem-connection 2.5 exposes no house timecode; recording/streaming
 * duration is the only timecode and is attached to recording events.)
 */
type AtemTimecodeT = { hours: number; minutes: number; seconds: number; frames: number };

export type AtemStateLikeT = {
  video?: {
    mixEffects?: Array<
      | {
          programInput: number;
          previewInput: number;
          upstreamKeyers?: Array<{ onAir: boolean } | undefined>;
        }
      | undefined
    >;
    downstreamKeyers?: Array<{ onAir: boolean } | undefined>;
  };
  recording?: { status?: { state: number }; duration?: AtemTimecodeT };
  streaming?: { status?: { state: number }; duration?: AtemTimecodeT };
  inputs?: Record<number, { longName?: string; shortName?: string } | undefined>;
};

/** atem-connection enums (copied to avoid a runtime import in pure code). */
const ATEM_RECORDING_RECORDING = 1;
const ATEM_STREAMING_STREAMING = 4;

function formatTimecode(tc: AtemTimecodeT | undefined): string | null {
  if (!tc) {
    return null;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(tc.hours)}:${pad(tc.minutes)}:${pad(tc.seconds)}:${pad(tc.frames)}`;
}

function inputName(state: AtemStateLikeT, input: number): string | null {
  const info = state.inputs?.[input];
  return info?.longName ?? info?.shortName ?? null;
}

/**
 * Derive switcher events from two consecutive ATEM states. Pure: the ATEM
 * adapter keeps the previous snapshot and forwards the result; on the first
 * state (prev undefined) every on-air fact is emitted once so a session log
 * always starts from a known state.
 */
export function diffAtemState(
  prev: AtemStateLikeT | undefined,
  next: AtemStateLikeT,
): SwitcherEventT[] {
  const events: SwitcherEventT[] = [];
  const source = "atem";

  const nextMes = next.video?.mixEffects ?? [];
  const prevMes = prev?.video?.mixEffects ?? [];
  nextMes.forEach((me, index) => {
    if (!me) {
      return;
    }
    const before = prevMes[index];
    if (!before || before.programInput !== me.programInput) {
      events.push({ type: "program_changed", source, me: index, input_id: String(me.programInput), input_name: inputName(next, me.programInput) });
    }
    if (!before || before.previewInput !== me.previewInput) {
      events.push({ type: "preview_changed", source, me: index, input_id: String(me.previewInput), input_name: inputName(next, me.previewInput) });
    }
    (me.upstreamKeyers ?? []).forEach((usk, k) => {
      if (!usk) {
        return;
      }
      // First state: report on-air keyers only; afterwards every change.
      const wasOnAir = before?.upstreamKeyers?.[k]?.onAir ?? false;
      if (usk.onAir !== wasOnAir) {
        events.push({ type: usk.onAir ? "keyer_on_air" : "keyer_off_air", source, me: index, keyer: `usk${k + 1}` });
      }
    });
  });

  const nextDsks = next.video?.downstreamKeyers ?? [];
  const prevDsks = prev?.video?.downstreamKeyers ?? [];
  nextDsks.forEach((dsk, k) => {
    if (!dsk) {
      return;
    }
    const wasOnAir = prevDsks[k]?.onAir ?? false;
    if (dsk.onAir !== wasOnAir) {
      events.push({ type: dsk.onAir ? "keyer_on_air" : "keyer_off_air", source, keyer: `dsk${k + 1}` });
    }
  });

  const wasRecording = prev?.recording?.status?.state === ATEM_RECORDING_RECORDING;
  const isRecording = next.recording?.status?.state === ATEM_RECORDING_RECORDING;
  if (isRecording !== wasRecording && (prev || isRecording)) {
    events.push({ type: isRecording ? "recording_started" : "recording_stopped", source, timecode: formatTimecode(next.recording?.duration) });
  }

  const wasStreaming = prev?.streaming?.status?.state === ATEM_STREAMING_STREAMING;
  const isStreaming = next.streaming?.status?.state === ATEM_STREAMING_STREAMING;
  if (isStreaming !== wasStreaming && (prev || isStreaming)) {
    events.push({ type: isStreaming ? "streaming_started" : "streaming_stopped", source, timecode: formatTimecode(next.streaming?.duration) });
  }

  return events;
}

/**
 * Plain, detached copy of the parts of an atem-connection state that
 * diffAtemState reads. atem-connection mutates its state object in place, so
 * the previous snapshot must be an independent copy.
 */
export function snapshotAtemState(state: AtemStateLikeT | null | undefined): AtemStateLikeT {
  if (!state) {
    return {};
  }
  const mixEffects = (state.video?.mixEffects ?? []).map((me) =>
    me
      ? {
          programInput: me.programInput,
          previewInput: me.previewInput,
          upstreamKeyers: (me.upstreamKeyers ?? []).map((usk) => (usk ? { onAir: Boolean(usk.onAir) } : undefined)),
        }
      : undefined,
  );
  const downstreamKeyers = (state.video?.downstreamKeyers ?? []).map((dsk) => (dsk ? { onAir: Boolean(dsk.onAir) } : undefined));
  const inputs: AtemStateLikeT["inputs"] = {};
  for (const [id, input] of Object.entries(state.inputs ?? {})) {
    if (input) {
      inputs[Number(id)] = { longName: input.longName, shortName: input.shortName };
    }
  }
  const copyTc = (tc: { hours: number; minutes: number; seconds: number; frames: number } | undefined) => (tc ? { ...tc } : undefined);
  return {
    video: { mixEffects, downstreamKeyers },
    recording: state.recording ? { status: state.recording.status ? { state: state.recording.status.state } : undefined, duration: copyTc(state.recording.duration) } : undefined,
    streaming: state.streaming ? { status: state.streaming.status ? { state: state.streaming.status.state } : undefined, duration: copyTc(state.streaming.duration) } : undefined,
    inputs,
  };
}
