import { diffMeetingSummary, summarizeMeetingStatus } from "./meeting-session-events.js";

describe("meeting session events", () => {
  test("summarises recorder and program state", () => {
    const s = summarizeMeetingStatus({ recording: { active: true }, engine: { program_revision: 7, program: { media_layer: { enabled: true, source: "screen", page: 3 } } } });
    expect(s).toEqual({ recordingActive: true, programRevision: 7, programLabel: "media:screen#3" });
    expect(summarizeMeetingStatus({ recording: null, engine: null })).toEqual({ recordingActive: false, programRevision: null, programLabel: null });
    expect(summarizeMeetingStatus({ engine: { program_revision: 1, program: { media_layer: { enabled: false } } } }).programLabel).toBe("camera");
  });

  test("diffs into recording and program events only on change", () => {
    const a = { recordingActive: false, programRevision: 1, programLabel: "camera" };
    const b = { recordingActive: true, programRevision: 2, programLabel: "media:page#1" };
    expect(diffMeetingSummary(null, a)).toEqual([{ type: "program_changed", source: "meeting", me: 0, input_id: "1", input_name: "camera" }]);
    expect(diffMeetingSummary(a, b).map((e) => e.type)).toEqual(["recording_started", "program_changed"]);
    expect(diffMeetingSummary(b, b)).toEqual([]);
    expect(diffMeetingSummary(b, { ...b, recordingActive: false })).toEqual([{ type: "recording_stopped", source: "meeting" }]);
  });
});
