import { MeetingCallControlError } from "./meeting-call-control-types.js";
import { executeMeetingCallControlWin32 } from "./meeting-call-control-win32.js";

const mockExecFile = jest.fn();

jest.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

type ExecCallbackT = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

const respondWith = (stdout: string, error: Error | null = null, stderr = "") => {
  mockExecFile.mockImplementation(
    (_cmd: string, _args: string[], _opts: unknown, callback: ExecCallbackT) => {
      callback(error, stdout, stderr);
    },
  );
};

/** Decodes the -EncodedCommand payload of the given execFile call. */
const decodeScript = (call = 0): string => {
  const args = mockExecFile.mock.calls[call][1] as string[];
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  return Buffer.from(encoded, "base64").toString("utf16le");
};

const expectCallControlError = async (
  promise: Promise<unknown>,
  code: string,
  messagePart?: string,
) => {
  await expect(promise).rejects.toMatchObject({
    name: "MeetingCallControlError",
    code,
    ...(messagePart ? { message: expect.stringContaining(messagePart) } : {}),
  });
};

describe("executeMeetingCallControlWin32", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("invokes powershell.exe with an encoded, non-interactive command", async () => {
    respondWith('{"result":"ok"}');

    await executeMeetingCallControlWin32("teams", "mic_toggle");

    const [cmd, args, opts] = mockExecFile.mock.calls[0] as [
      string,
      string[],
      { timeout: number; windowsHide: boolean },
    ];
    expect(cmd).toBe("powershell.exe");
    expect(args).toEqual(
      expect.arrayContaining(["-NoProfile", "-NonInteractive", "-EncodedCommand"]),
    );
    expect(opts.timeout).toBe(8000);
    expect(opts.windowsHide).toBe(true);
  });

  it("sends Ctrl+Shift+M to the Teams main window for mic_toggle", async () => {
    respondWith('{"result":"ok"}');

    const result = await executeMeetingCallControlWin32("teams", "mic_toggle");

    const script = decodeScript();
    expect(script).toContain("'ms-teams','Teams'");
    expect(script).toContain("Add-Type");
    expect(script).toContain("SetForegroundWindow");
    // Chord: Ctrl (0x11) + Shift (0x10) down, M (0x4d) tap, reversed up.
    expect(script).toContain("keybd_event(0x11, 0, 0");
    expect(script).toContain("keybd_event(0x10, 0, 0");
    expect(script).toContain("keybd_event(0x4d, 0, 0");
    expect(script).toContain("keybd_event(0x4d, 0, 2");
    expect(result).toEqual({ platform: "teams", action: "mic_toggle" });
  });

  it("sends Alt+Q then Enter after a delay for the Zoom hangup", async () => {
    respondWith('{"result":"ok"}');

    await executeMeetingCallControlWin32("zoom", "hangup");

    const script = decodeScript();
    expect(script).toContain("'Zoom'");
    expect(script).toContain("keybd_event(0x12, 0, 0"); // Alt down
    expect(script).toContain("keybd_event(0x51, 0, 0"); // Q down
    expect(script).toContain("Start-Sleep -Milliseconds 350");
    expect(script).toContain("keybd_event(0xd, 0, 0"); // Enter confirms leave
  });

  it("toggles the speaker via VK_VOLUME_MUTE without focus or Add-Type", async () => {
    respondWith('{"result":"ok"}');

    const result = await executeMeetingCallControlWin32("zoom", "speaker_toggle");

    const script = decodeScript();
    expect(script).toContain("[char]173");
    expect(script).not.toContain("Add-Type");
    expect(script).not.toContain("SetForegroundWindow");
    // No state read-back on Windows - the field must be absent, not false.
    expect(result).toEqual({ platform: "zoom", action: "speaker_toggle" });
    expect("speakerMuted" in result).toBe(false);
  });

  it("maps a missing client window to client_not_running", async () => {
    respondWith('{"result":"not_found"}');

    await expectCallControlError(
      executeMeetingCallControlWin32("zoom", "mic_toggle"),
      "client_not_running",
      "Zoom is not running",
    );
  });

  it("maps a failed window activation to automation_failed", async () => {
    respondWith('{"result":"activation_failed"}');

    await expectCallControlError(
      executeMeetingCallControlWin32("teams", "hangup"),
      "automation_failed",
      "focus",
    );
  });

  it("maps execFile errors (timeout, missing powershell) to automation_failed", async () => {
    respondWith("", new Error("spawn powershell.exe ETIMEDOUT"), "boom");

    await expectCallControlError(
      executeMeetingCallControlWin32("teams", "mic_toggle"),
      "automation_failed",
      "ETIMEDOUT",
    );
  });

  it("treats unparsable script output as automation_failed", async () => {
    respondWith("Constrained language mode banner");

    const promise = executeMeetingCallControlWin32("teams", "mic_toggle");
    await expect(promise).rejects.toBeInstanceOf(MeetingCallControlError);
    await expectCallControlError(
      executeMeetingCallControlWin32("teams", "mic_toggle"),
      "automation_failed",
    );
  });

  it("ignores leading noise and reads the status from the last output line", async () => {
    respondWith('Some AV banner\r\n{"result":"ok"}');

    await expect(
      executeMeetingCallControlWin32("teams", "mic_toggle"),
    ).resolves.toEqual({ platform: "teams", action: "mic_toggle" });
  });
});