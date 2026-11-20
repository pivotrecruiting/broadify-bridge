import type { SwitcherEventT } from "./session-log-types.js";

/**
 * Meeting mode as a "switcher" for the SessionEventLog: the native helper
 * composes the program (camera + media layer) and reports a monotonic
 * `program_revision`; the meeting recorder reports `recording.active`.
 * Pure diff over two status summaries so the manager only calls one function
 * per published status.
 */
export type MeetingSessionSummaryT = {
  recordingActive: boolean;
  programRevision: number | null;
  /** Human-readable program description (media layer mode/source, camera render). */
  programLabel: string | null;
};

export function summarizeMeetingStatus(status: Record<string, unknown> | null | undefined): MeetingSessionSummaryT {
  const recording = status?.recording;
  const engine = status?.engine;
  const recordingActive = !!recording && typeof recording === "object" && (recording as Record<string, unknown>).active === true;
  let programRevision: number | null = null;
  let programLabel: string | null = null;
  if (engine && typeof engine === "object") {
    const e = engine as Record<string, unknown>;
    programRevision = typeof e.program_revision === "number" ? e.program_revision : null;
    const program = e.program && typeof e.program === "object" ? (e.program as Record<string, unknown>) : null;
    const media = program?.media_layer && typeof program.media_layer === "object" ? (program.media_layer as Record<string, unknown>) : null;
    const parts: string[] = [];
    if (media?.enabled === true) {
      parts.push(`media:${String(media.source ?? media.mode ?? "on")}${typeof media.page === "number" ? `#${media.page}` : ""}`);
    } else {
      parts.push("camera");
    }
    programLabel = parts.join(" ");
  }
  return { recordingActive, programRevision, programLabel };
}

export function diffMeetingSummary(prev: MeetingSessionSummaryT | null, next: MeetingSessionSummaryT): SwitcherEventT[] {
  const events: SwitcherEventT[] = [];
  const source = "meeting";
  if (next.recordingActive !== (prev?.recordingActive ?? false)) {
    events.push({ type: next.recordingActive ? "recording_started" : "recording_stopped", source });
  }
  if (next.programRevision !== null && next.programRevision !== (prev?.programRevision ?? null)) {
    events.push({ type: "program_changed", source, me: 0, input_id: String(next.programRevision), input_name: next.programLabel });
  }
  return events;
}
