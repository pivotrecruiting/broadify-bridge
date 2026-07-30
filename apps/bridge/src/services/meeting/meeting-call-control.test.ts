import { executeMeetingCallControl } from "./meeting-call-control.js";

const mockPlatform = jest.fn();
const mockDarwinDriver = jest.fn();
const mockWin32Driver = jest.fn();

jest.mock("node:os", () => ({
  platform: () => mockPlatform(),
}));

jest.mock("./meeting-call-control-darwin.js", () => ({
  executeMeetingCallControlDarwin: (...args: unknown[]) =>
    mockDarwinDriver(...args),
}));

jest.mock("./meeting-call-control-win32.js", () => ({
  executeMeetingCallControlWin32: (...args: unknown[]) =>
    mockWin32Driver(...args),
}));

describe("executeMeetingCallControl dispatcher", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("routes darwin to the osascript driver", async () => {
    mockPlatform.mockReturnValue("darwin");
    mockDarwinDriver.mockResolvedValue({ platform: "teams", action: "hangup" });

    await executeMeetingCallControl("teams", "hangup");

    expect(mockDarwinDriver).toHaveBeenCalledWith("teams", "hangup");
    expect(mockWin32Driver).not.toHaveBeenCalled();
  });

  it("routes win32 to the PowerShell driver", async () => {
    mockPlatform.mockReturnValue("win32");
    mockWin32Driver.mockResolvedValue({ platform: "zoom", action: "mic_toggle" });

    await executeMeetingCallControl("zoom", "mic_toggle");

    expect(mockWin32Driver).toHaveBeenCalledWith("zoom", "mic_toggle");
    expect(mockDarwinDriver).not.toHaveBeenCalled();
  });

  it("rejects other platforms with unsupported_os", async () => {
    mockPlatform.mockReturnValue("linux");

    await expect(
      executeMeetingCallControl("teams", "mic_toggle"),
    ).rejects.toMatchObject({ code: "unsupported_os" });
    expect(mockDarwinDriver).not.toHaveBeenCalled();
    expect(mockWin32Driver).not.toHaveBeenCalled();
  });
});