import {
  isTransientMeetingRecordingProbeFailure,
  MEETING_RECORDING_PROBE_ARG,
  MEETING_RECORDING_PROBE_TIMEOUT_MS,
  parseMeetingRecordingProbeOutput,
  runMeetingRecordingProbe,
} from "./meeting-recording-probe.js";

const MAC_LINE =
  '{"type":"recording_probe","backend":"videotoolbox","ok":true,"encoders":[' +
  '{"codec":"prores_422","name":"AppleProResHW 422"},' +
  '{"codec":"h264","name":"Apple H.264 (HW)"},' +
  '{"codec":"hevc","name":"Apple HEVC (HW)"}]}';

type ExecCallbackT = (
  error: (Error & { killed?: boolean; code?: unknown }) | null,
  stdout: string,
) => void;

/** Probe deps with an installed helper whose run the test scripts. */
const depsWith = (run: (callback: ExecCallbackT) => void) => {
  const execHelper = jest.fn(
    (
      _helperPath: string,
      _args: string[],
      _options: { timeout: number; maxBuffer: number; windowsHide: boolean },
      callback: ExecCallbackT,
    ) => run(callback),
  );
  return { helperExists: () => true, execHelper };
};

describe("meeting-recording-probe", () => {
  describe("parseMeetingRecordingProbeOutput", () => {
    it("reads the probe line", () => {
      expect(parseMeetingRecordingProbeOutput(`${MAC_LINE}\n`)).toEqual({
        ok: true,
        probe: {
          backend: "videotoolbox",
          encoders: [
            { codec: "prores_422", name: "AppleProResHW 422" },
            { codec: "h264", name: "Apple H.264 (HW)" },
            { codec: "hevc", name: "Apple HEVC (HW)" },
          ],
        },
      });
    });

    it("keeps the vendor a Windows helper reports", () => {
      const line =
        '{"type":"recording_probe","backend":"mediafoundation","ok":true,"encoders":[' +
        '{"codec":"h264","name":"NVIDIA H.264 Encoder MFT","vendor":"nvidia"}]}';
      expect(parseMeetingRecordingProbeOutput(line)).toEqual({
        ok: true,
        probe: {
          backend: "mediafoundation",
          encoders: [
            { codec: "h264", name: "NVIDIA H.264 Encoder MFT", vendor: "nvidia" },
          ],
        },
      });
    });

    it("skips other helper output around the probe line", () => {
      const stdout = [
        "starting up",
        '{"type":"meeting_helper_build","git_sha":"abc"}',
        "{not json",
        MAC_LINE,
        "",
      ].join("\r\n");
      expect(parseMeetingRecordingProbeOutput(stdout).ok).toBe(true);
    });

    it("accepts a machine without any hardware encoder", () => {
      expect(
        parseMeetingRecordingProbeOutput(
          '{"type":"recording_probe","backend":"mediafoundation","ok":true,"encoders":[]}',
        ),
      ).toEqual({ ok: true, probe: { backend: "mediafoundation", encoders: [] } });
    });

    it("treats an enumeration the helper reports as failed as a failure, not as no encoders", () => {
      expect(
        parseMeetingRecordingProbeOutput(
          '{"type":"recording_probe","backend":"mediafoundation","ok":false,"encoders":[]}',
        ),
      ).toEqual({ ok: false, reason: "enumeration_failed" });
    });

    it.each([
      ["no output", ""],
      ["no probe line", '{"type":"ready"}\n'],
      ["an unknown codec", '{"type":"recording_probe","backend":"x","ok":true,"encoders":[{"codec":"av1","name":"n"}]}'],
      ["a missing encoder list", '{"type":"recording_probe","backend":"x","ok":true}'],
      ["a non-boolean ok", '{"type":"recording_probe","backend":"x","ok":"yes","encoders":[]}'],
    ])("rejects %s", (_name, stdout) => {
      expect(parseMeetingRecordingProbeOutput(stdout)).toEqual({
        ok: false,
        reason: "invalid_output",
      });
    });
  });

  describe("runMeetingRecordingProbe", () => {
    it("runs the helper in probe mode with a timeout and returns the parsed result", async () => {
      const deps = depsWith((callback) => callback(null, MAC_LINE));

      const outcome = await runMeetingRecordingProbe("/path/to/helper", deps);

      expect(outcome.ok).toBe(true);
      expect(deps.execHelper).toHaveBeenCalledTimes(1);
      expect(deps.execHelper).toHaveBeenCalledWith(
        "/path/to/helper",
        [MEETING_RECORDING_PROBE_ARG],
        expect.objectContaining({
          timeout: MEETING_RECORDING_PROBE_TIMEOUT_MS,
          windowsHide: true,
        }),
        expect.any(Function),
      );
      expect(MEETING_RECORDING_PROBE_ARG).toBe("--probe-recording");
    });

    it("does not spawn anything when the helper is not installed", async () => {
      const deps = { ...depsWith(() => undefined), helperExists: () => false };

      expect(await runMeetingRecordingProbe("/missing/helper", deps)).toEqual({
        ok: false,
        reason: "helper_missing",
      });
      expect(deps.execHelper).not.toHaveBeenCalled();
    });

    it("reports a helper killed by the timeout as timeout", async () => {
      const deps = depsWith((callback) =>
        callback(Object.assign(new Error("killed"), { killed: true }), ""),
      );

      expect(await runMeetingRecordingProbe("/path/to/helper", deps)).toEqual({
        ok: false,
        reason: "timeout",
      });
    });

    it.each([
      ["killed for it", { killed: true }],
      ["not flagged as killed", {}],
    ])(
      "reports a helper that exceeds the output limit (%s) as invalid_output, not as timeout",
      async (_name, flags) => {
        const deps = depsWith((callback) =>
          callback(
            Object.assign(new Error("stdout maxBuffer length exceeded"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
              ...flags,
            }),
            "",
          ),
        );

        expect(await runMeetingRecordingProbe("/path/to/helper", deps)).toEqual({
          ok: false,
          reason: "invalid_output",
        });
      },
    );

    it("reports a helper that exits with an error as spawn_failed, whatever it printed", async () => {
      const deps = depsWith((callback) =>
        callback(new Error("exit code 2"), MAC_LINE),
      );

      expect(await runMeetingRecordingProbe("/path/to/helper", deps)).toEqual({
        ok: false,
        reason: "spawn_failed",
      });
    });

    it("reports a spawn that throws as spawn_failed instead of rejecting", async () => {
      const deps = depsWith(() => {
        throw new Error("EACCES");
      });

      await expect(
        runMeetingRecordingProbe("/path/to/helper", deps),
      ).resolves.toEqual({ ok: false, reason: "spawn_failed" });
    });

    it("reports unusable output as invalid_output", async () => {
      const deps = depsWith((callback) => callback(null, "meeting-helper requires --run"));

      expect(await runMeetingRecordingProbe("/path/to/helper", deps)).toEqual({
        ok: false,
        reason: "invalid_output",
      });
    });
  });

  describe("isTransientMeetingRecordingProbeFailure", () => {
    it.each([
      ["timeout", true],
      ["spawn_failed", true],
      ["helper_missing", false],
      ["invalid_output", false],
      ["enumeration_failed", false],
    ] as const)("%s -> %s", (reason, transient) => {
      expect(isTransientMeetingRecordingProbeFailure(reason)).toBe(transient);
    });
  });
});
