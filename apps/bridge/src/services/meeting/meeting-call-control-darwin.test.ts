import { executeMeetingCallControlDarwin } from "./meeting-call-control-darwin.js";

const mockExecFile = jest.fn();

jest.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

type ExecCallbackT = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

/** Answers osascript calls in order: [stdout | Error, ...]. */
const respondInOrder = (responses: Array<string | Error>) => {
  let call = 0;
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallbackT) => {
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      if (response instanceof Error) {
        callback(response, "", response.message);
      } else {
        callback(null, response, "");
      }
    },
  );
};

const scriptOfCall = (call: number): string =>
  (mockExecFile.mock.calls[call][1] as string[])[1];

describe("executeMeetingCallControlDarwin (regression for the extracted driver)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("focuses the running Teams process and sends Cmd+Shift+M for mic_toggle", async () => {
    respondInOrder(["Finder, MSTeams, Dock", ""]);

    const result = await executeMeetingCallControlDarwin("teams", "mic_toggle");

    expect(scriptOfCall(0)).toContain("get name of every process");
    const script = scriptOfCall(1);
    expect(script).toContain('set frontmost of process "MSTeams" to true');
    expect(script).toContain('keystroke "m" using {command down, shift down}');
    expect(result).toEqual({ platform: "teams", action: "mic_toggle" });
  });

  it("confirms the Zoom leave dialog with Return after Cmd+W", async () => {
    respondInOrder(["zoom.us, Finder", ""]);

    await executeMeetingCallControlDarwin("zoom", "hangup");

    const script = scriptOfCall(1);
    expect(script).toContain('keystroke "w" using {command down}');
    expect(script).toContain("key code 36");
  });

  it("throws client_not_running when the client process is absent", async () => {
    respondInOrder(["Finder, Dock"]);

    await expect(
      executeMeetingCallControlDarwin("zoom", "mic_toggle"),
    ).rejects.toMatchObject({
      code: "client_not_running",
      message: expect.stringContaining("zoom.us"),
    });
  });

  it("maps assistive-access failures to accessibility_permission_required", async () => {
    respondInOrder([
      new Error("osascript is not allowed assistive access (-25211)"),
    ]);

    await expect(
      executeMeetingCallControlDarwin("teams", "mic_toggle"),
    ).rejects.toMatchObject({ code: "accessibility_permission_required" });
  });

  it("returns the new system mute state for speaker_toggle", async () => {
    respondInOrder(["true"]);

    await expect(
      executeMeetingCallControlDarwin("teams", "speaker_toggle"),
    ).resolves.toEqual({
      platform: "teams",
      action: "speaker_toggle",
      speakerMuted: true,
    });
  });
});