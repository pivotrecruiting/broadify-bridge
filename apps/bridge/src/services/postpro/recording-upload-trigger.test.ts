import {
  decideFinishedRecording,
  diffRecordingSummary,
  isUploadableRecordingCodec,
  summarizeRecordingStatus,
  type RecordingUploadSummaryT,
} from "./recording-upload-trigger.js";

const PROGRAM_FORMAT = { width: 1920, height: 1080, fps: 50 };

const runningStatus = (recording: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  manager: { state: "running" },
  engine: { program_revision: 1 },
  recording,
  program_format: PROGRAM_FORMAT,
  ...extra,
});

const activeRecording = (overrides: Record<string, unknown> = {}) => ({
  active: true,
  file_path: "/Users/someone/Movies/Broadify/Broadify-Meeting-1.mp4.part",
  codec: "h264",
  container: "mp4",
  elapsed_seconds: 12,
  last_error: "",
  ...overrides,
});

const summary = (overrides: Partial<RecordingUploadSummaryT> = {}): RecordingUploadSummaryT => ({
  active: false,
  filePath: null,
  codec: null,
  lastError: "",
  elapsedSeconds: null,
  programFormat: PROGRAM_FORMAT,
  ...overrides,
});

describe("summarizeRecordingStatus", () => {
  it("reads the running recording and strips the .part suffix from its path", () => {
    expect(summarizeRecordingStatus(runningStatus(activeRecording()))).toEqual({
      active: true,
      filePath: "/Users/someone/Movies/Broadify/Broadify-Meeting-1.mp4",
      codec: "h264",
      lastError: "",
      elapsedSeconds: 12,
      programFormat: PROGRAM_FORMAT,
    });
  });

  it("keeps a Windows path and a path without .part as they are", () => {
    const windows = summarizeRecordingStatus(
      runningStatus(activeRecording({ file_path: "C:\\Users\\a\\Videos\\Broadify\\take.mp4.part" })),
    );
    expect(windows?.filePath).toBe("C:\\Users\\a\\Videos\\Broadify\\take.mp4");
    const finished = summarizeRecordingStatus(
      runningStatus(activeRecording({ active: false, file_path: "/tmp/take.mov", codec: "prores_422" })),
    );
    expect(finished).toMatchObject({ active: false, filePath: "/tmp/take.mov", codec: "prores_422" });
  });

  it("treats a codec outside the contract as unknown", () => {
    expect(summarizeRecordingStatus(runningStatus(activeRecording({ codec: "av1" })))?.codec).toBeNull();
    expect(summarizeRecordingStatus(runningStatus(activeRecording({ codec: null })))?.codec).toBeNull();
  });

  it("is inactive without an engine (stopped, exited or crashed helper)", () => {
    expect(summarizeRecordingStatus({ manager: { state: "stopped" }, engine: null, recording: null, program_format: null })).toEqual({
      active: false,
      filePath: null,
      codec: null,
      lastError: null,
      elapsedSeconds: null,
      programFormat: null,
    });
  });

  it("is unknown while the helper cannot be asked (never mistaken for a stop)", () => {
    // Transient control failure: the manager reports engineError and recording null.
    expect(summarizeRecordingStatus({ engine: null, engineError: "timeout", recording: null })).toBeNull();
    // recording.status timed out (a finalizing stop blocks the control thread) while the engine answered.
    expect(summarizeRecordingStatus(runningStatus(null))).toBeNull();
    expect(summarizeRecordingStatus(null)).toBeNull();
    expect(summarizeRecordingStatus(undefined)).toBeNull();
  });
});

describe("diffRecordingSummary", () => {
  const active = summary({ active: true, filePath: "/r/a.mp4", codec: "h264", elapsedSeconds: 3 });

  it("reports a start with path, codec and program format", () => {
    expect(diffRecordingSummary(null, active)).toEqual([
      { type: "started", filePath: "/r/a.mp4", codec: "h264", programFormat: PROGRAM_FORMAT },
      { type: "progress", elapsedSeconds: 3 },
    ]);
  });

  it("reports only progress while the same recording runs", () => {
    expect(diffRecordingSummary(active, { ...active, elapsedSeconds: 5 })).toEqual([{ type: "progress", elapsedSeconds: 5 }]);
  });

  it("reports a stop with the recorder's last error", () => {
    expect(diffRecordingSummary(active, summary({ filePath: "/r/a.mp4", codec: "h264", lastError: "" }))).toEqual([
      { type: "stopped", lastError: "" },
    ]);
    expect(diffRecordingSummary(active, summary({ lastError: "finalize_timeout" }))).toEqual([
      { type: "stopped", lastError: "finalize_timeout" },
    ]);
  });

  it("reports a stop without an error value when the engine is gone", () => {
    expect(diffRecordingSummary(active, summary({ lastError: null, programFormat: null }))).toEqual([
      { type: "stopped", lastError: null },
    ]);
  });

  it("reports nothing between two inactive statuses", () => {
    expect(diffRecordingSummary(null, summary())).toEqual([]);
    expect(diffRecordingSummary(summary(), summary())).toEqual([]);
  });

  it("treats another active file as a stop followed by a start", () => {
    expect(diffRecordingSummary(active, { ...active, filePath: "/r/b.mp4", elapsedSeconds: 0 })).toEqual([
      { type: "stopped", lastError: null },
      { type: "started", filePath: "/r/b.mp4", codec: "h264", programFormat: PROGRAM_FORMAT },
      { type: "progress", elapsedSeconds: 0 },
    ]);
  });

  it.each([
    ["path", { filePath: null }],
    ["codec", { codec: null }],
    ["program format", { programFormat: null }],
  ])("does not report a start without a %s", (_name, missing) => {
    const transitions = diffRecordingSummary(null, { ...active, ...missing });
    expect(transitions.some((transition) => transition.type === "started")).toBe(false);
  });
});

describe("decideFinishedRecording", () => {
  const clean = { enabled: true, codec: "h264" as const, lastError: "", fileSizeBytes: 1024, partExists: false };

  it("enqueues a cleanly finished H.264 or HEVC recording", () => {
    expect(decideFinishedRecording(clean)).toEqual({ action: "enqueue" });
    expect(decideFinishedRecording({ ...clean, codec: "hevc" })).toEqual({ action: "enqueue" });
    // Engine gone (no recorder error value) but the file is complete: quit while recording.
    expect(decideFinishedRecording({ ...clean, lastError: null })).toEqual({ action: "enqueue" });
  });

  it("drops everything silently while the opt-in is off", () => {
    expect(decideFinishedRecording({ ...clean, enabled: false })).toEqual({ action: "drop", reason: null });
    expect(decideFinishedRecording({ ...clean, enabled: false, codec: "prores_422" })).toEqual({ action: "drop", reason: null });
  });

  it.each(["prores_422_lt", "prores_422", "prores_422_hq"] as const)("keeps a %s master local", (codec) => {
    expect(decideFinishedRecording({ ...clean, codec })).toEqual({ action: "drop", reason: "prores_master_local" });
  });

  it("drops a failed recording", () => {
    expect(decideFinishedRecording({ ...clean, lastError: "finalize_timeout" })).toEqual({ action: "drop", reason: "recording_failed" });
  });

  it("drops a recording whose .part sibling still exists", () => {
    expect(decideFinishedRecording({ ...clean, partExists: true })).toEqual({ action: "drop", reason: "file_incomplete" });
    expect(decideFinishedRecording({ ...clean, partExists: true, fileSizeBytes: null })).toEqual({ action: "drop", reason: "file_incomplete" });
  });

  it("drops a missing or empty file", () => {
    expect(decideFinishedRecording({ ...clean, fileSizeBytes: null })).toEqual({ action: "drop", reason: "file_missing" });
    expect(decideFinishedRecording({ ...clean, fileSizeBytes: 0 })).toEqual({ action: "drop", reason: "file_missing" });
  });

  it("knows the uploadable codecs", () => {
    expect(isUploadableRecordingCodec("h264")).toBe(true);
    expect(isUploadableRecordingCodec("hevc")).toBe(true);
    expect(isUploadableRecordingCodec("prores_422")).toBe(false);
  });
});
