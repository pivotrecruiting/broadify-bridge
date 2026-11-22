import { pickRecordingSavePath } from "./meeting-recording-dialog.js";

jest.mock("node:os", () => ({
  homedir: () => "/Users/test-user",
  platform: () => "darwin",
}));

type ExecCallbackT = (error: Error | null, stdout: string) => void;
const mockExecFile = jest.fn();
jest.mock("node:child_process", () => ({
  execFile: (...args: unknown[]) => mockExecFile(...args),
}));

/** Lets the mocked osascript answer with the given panel result. */
const answerPanel = (error: Error | null, stdout: string): void => {
  mockExecFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: ExecCallbackT) =>
      callback(error, stdout),
  );
};

/** The AppleScript handed to osascript by the last call. */
const lastScript = (): string => (mockExecFile.mock.calls.at(-1) as [string, string[]])[1][1];

describe("pickRecordingSavePath (macOS save panel)", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("keeps a chosen .mp4 path and appends the extension when it is missing", async () => {
    answerPanel(null, "/Users/op/Movies/take.mp4\n");
    await expect(pickRecordingSavePath("take.mp4", "en")).resolves.toBe(
      "/Users/op/Movies/take.mp4",
    );
    answerPanel(null, "/Users/op/Movies/take\n");
    await expect(pickRecordingSavePath("take.mp4", "en")).resolves.toBe(
      "/Users/op/Movies/take.mp4",
    );
  });

  it("enforces the extension of the requested container on name and result", async () => {
    // A ProRes recording goes into .mov: the panel proposes it, and a name
    // the user typed with another recording extension is corrected.
    answerPanel(null, "/Users/op/Movies/take.mp4\n");
    await expect(pickRecordingSavePath("meeting.mp4", "de", "mov")).resolves.toBe(
      "/Users/op/Movies/take.mov",
    );
    expect(lastScript()).toContain('default name "meeting.mov"');
    expect(lastScript()).toContain("Meeting-Aufnahme speichern");
  });

  it("returns null when the panel is cancelled or returns nothing", async () => {
    answerPanel(new Error("User canceled. (-128)"), "");
    await expect(pickRecordingSavePath("take.mp4", "en", "mov")).resolves.toBeNull();
    answerPanel(null, "  \n");
    await expect(pickRecordingSavePath("take.mp4", "en", "mov")).resolves.toBeNull();
  });
});
