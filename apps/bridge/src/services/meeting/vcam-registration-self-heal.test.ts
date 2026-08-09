import { setBridgeContext } from "../bridge-context.js";
import {
  __resetVcamRegistrationSelfHealForTesting,
  resolveVcamHelperDllPath,
  runVcamStartWithRegistrationSelfHeal,
} from "./vcam-registration-self-heal.js";

describe("vcam-registration-self-heal", () => {
  const fs = require("node:fs");
  const childProcess = require("node:child_process");

  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const originalPlatform = process.platform;

  const setPlatform = (platform: string): void => {
    Object.defineProperty(process, "platform", {
      value: platform,
      configurable: true,
    });
  };

  const mockExecFileSuccess = (): jest.SpyInstance =>
    jest
      .spyOn(childProcess, "execFile")
      .mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (error: Error | null) => void;
        callback(null);
        return {} as never;
      });

  const classNotRegisteredError = new Error(
    "IMFVirtualCamera::Start failed 0x80040154 (is broadify-vcam.dll registered? regsvr32 requires elevation)",
  );

  beforeEach(() => {
    jest.clearAllMocks();
    __resetVcamRegistrationSelfHealForTesting();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setPlatform(originalPlatform);
  });

  it("registers the DLL once and retries the start exactly once", async () => {
    setPlatform("win32");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const execFileSpy = mockExecFileSuccess();
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).resolves.toEqual({ started: true });

    expect(startVcam).toHaveBeenCalledTimes(2);
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(execFileSpy).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        expect.stringContaining("-Verb RunAs -Wait"),
      ],
      expect.objectContaining({ timeout: 60_000 }),
      expect.any(Function),
    );
  });

  it("leaves non-matching errors untouched", async () => {
    setPlatform("win32");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const execFileSpy = mockExecFileSuccess();
    const otherError = new Error("IMFVirtualCamera::Start failed 0x80070005");
    const startVcam = jest.fn().mockRejectedValue(otherError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80070005");

    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it("does not re-prompt after a second failure in the same session", async () => {
    setPlatform("win32");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const execFileSpy = mockExecFileSuccess();
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80040154");
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80040154");

    // First call: original try + heal + one retry. Second call: no heal, no
    // retry - just the original attempt surfacing its error.
    expect(execFileSpy).toHaveBeenCalledTimes(1);
    expect(startVcam).toHaveBeenCalledTimes(3);
  });

  it("is a no-op on non-Windows platforms", async () => {
    setPlatform("darwin");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    const execFileSpy = mockExecFileSuccess();
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80040154");

    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(execFileSpy).not.toHaveBeenCalled();
  });

  it("skips with a warning when the packaged DLL is missing (dev run)", async () => {
    setPlatform("win32");
    jest.spyOn(fs, "existsSync").mockReturnValue(false);
    const execFileSpy = mockExecFileSuccess();
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80040154");

    expect(execFileSpy).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("DLL not found"),
    );
  });

  it("logs the exact admin command and surfaces the original error when elevation fails", async () => {
    setPlatform("win32");
    jest.spyOn(fs, "existsSync").mockReturnValue(true);
    jest
      .spyOn(childProcess, "execFile")
      .mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (error: Error | null) => void;
        callback(new Error("The operation was canceled by the user."));
        return {} as never;
      });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam),
    ).rejects.toThrow("0x80040154");

    // No retry after a declined elevation.
    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`regsvr32 "${resolveVcamHelperDllPath()}"`),
    );
  });
});
