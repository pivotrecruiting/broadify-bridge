import { setBridgeContext } from "../bridge-context.js";
import {
  __resetVcamRegistrationSelfHealForTesting,
  parseRegQueryDefaultValue,
  probeVcamRegistration,
  runVcamStartWithRegistrationSelfHeal,
  VCAM_CLSID,
  type ExecFileLikeT,
} from "./vcam-registration-self-heal.js";

type ExecCallT = { file: string; args: string[] };

const DLL_PATH =
  "C:\\Program Files\\BroadifyBridge\\resources\\native\\vcam-helper\\broadify-vcam.dll";
const REG_QUERY_HIT = `\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${VCAM_CLSID}\\InprocServer32\r\n    (Default)    REG_SZ    ${DLL_PATH}\r\n\r\n`;
const REG_QUERY_MISS_STDERR =
  "ERROR: The system was unable to find the specified registry key or value.\r\n";

const execError = (message: string, code?: number): Error =>
  Object.assign(new Error(message), code === undefined ? {} : { code });

/**
 * Fake execFile: `regQuery` results are consumed per call (so the probe
 * before and after regsvr32 can differ), `regsvr32` decides the PowerShell
 * outcome.
 */
const createExecFile = (options: {
  regQuery: Array<{ stdout?: string; stderr?: string; error?: Error }>;
  regsvr32?: Error | null;
}): { execFile: ExecFileLikeT; calls: ExecCallT[] } => {
  const calls: ExecCallT[] = [];
  const queue = [...options.regQuery];
  const execFile: ExecFileLikeT = (file, args, _options, callback) => {
    calls.push({ file, args });
    if (file === "reg.exe") {
      const next = queue.shift();
      if (!next) {
        throw new Error("unexpected reg.exe call");
      }
      callback(next.error ?? null, next.stdout ?? "", next.stderr ?? "");
      return;
    }
    if (file === "powershell.exe") {
      callback(options.regsvr32 ?? null, "", "");
      return;
    }
    throw new Error(`unexpected exec of ${file}`);
  };
  return { execFile, calls };
};

const registered = { stdout: REG_QUERY_HIT };
const missing = {
  error: execError("Command failed: reg.exe query", 1),
  stderr: REG_QUERY_MISS_STDERR,
};
const probeBroken = { error: execError("spawn reg.exe ENOENT") };

describe("vcam-registration-self-heal", () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const classNotRegisteredError = new Error(
    "IMFVirtualCamera::Start failed 0x80040154 (is broadify-vcam.dll registered? regsvr32 requires elevation)",
  );
  const accessDeniedError = new Error(
    "IMFVirtualCamera::Start failed 0x80070005",
  );

  const baseDeps = (existing: Set<string> = new Set([DLL_PATH])) => ({
    existsSync: (path: string) => existing.has(path),
    resolveDllPath: () => DLL_PATH,
    platform: "win32" as const,
  });

  const regsvr32Calls = (calls: ExecCallT[]): ExecCallT[] =>
    calls.filter((call) => call.file === "powershell.exe");

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

  describe("parseRegQueryDefaultValue", () => {
    it("extracts the InprocServer32 default value", () => {
      expect(parseRegQueryDefaultValue(REG_QUERY_HIT)).toBe(DLL_PATH);
      expect(
        parseRegQueryDefaultValue(
          "    (Default)    REG_EXPAND_SZ    %ProgramFiles%\\x\\a.dll\r\n",
        ),
      ).toBe("%ProgramFiles%\\x\\a.dll");
      expect(parseRegQueryDefaultValue("")).toBeNull();
    });
  });

  describe("probeVcamRegistration", () => {
    it("queries the 64-bit HKLM view and classifies registered/stale/missing", async () => {
      const hit = createExecFile({ regQuery: [registered, registered] });
      await expect(
        probeVcamRegistration({
          execFile: hit.execFile,
          existsSync: () => true,
        }),
      ).resolves.toEqual({ state: "registered", dllPath: DLL_PATH });
      expect(hit.calls[0]).toEqual({
        file: "reg.exe",
        args: [
          "query",
          `HKLM\\SOFTWARE\\Classes\\CLSID\\${VCAM_CLSID}\\InprocServer32`,
          "/ve",
          "/reg:64",
        ],
      });
      await expect(
        probeVcamRegistration({
          execFile: hit.execFile,
          existsSync: () => false,
        }),
      ).resolves.toEqual({ state: "stale", dllPath: DLL_PATH });

      const miss = createExecFile({ regQuery: [missing] });
      await expect(
        probeVcamRegistration({ execFile: miss.execFile }),
      ).resolves.toEqual({ state: "missing" });

      const broken = createExecFile({ regQuery: [probeBroken] });
      await expect(
        probeVcamRegistration({ execFile: broken.execFile }),
      ).resolves.toEqual({
        state: "unknown",
        reason: "spawn reg.exe ENOENT",
      });
    });
  });

  it("registers a missing CLSID once, verifies it and retries the start exactly once", async () => {
    const exec = createExecFile({ regQuery: [missing, registered] });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).resolves.toEqual({ started: true });

    expect(startVcam).toHaveBeenCalledTimes(2);
    const elevated = regsvr32Calls(exec.calls);
    expect(elevated).toHaveLength(1);
    expect(elevated[0].args).toEqual([
      "-NoProfile",
      "-Command",
      expect.stringMatching(
        /^\$p = Start-Process -FilePath regsvr32\.exe -ArgumentList '\/s','C:\\Program Files.*' -Verb RunAs -Wait -PassThru; exit \$p\.ExitCode$/,
      ),
    ]);
    expect(exec.calls.map((call) => call.file)).toEqual([
      "reg.exe",
      "powershell.exe",
      "reg.exe",
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("VCam DLL registered"),
    );
  });

  it("re-registers a stale CLSID whose DLL path no longer exists, even without 0x80040154", async () => {
    const staleHit = {
      stdout: REG_QUERY_HIT.replace(DLL_PATH, "C:\\Users\\old\\gone.dll"),
    };
    const exec = createExecFile({ regQuery: [staleHit, registered] });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(accessDeniedError)
      .mockResolvedValueOnce({ started: true });

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).resolves.toEqual({ started: true });

    expect(regsvr32Calls(exec.calls)).toHaveLength(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "points at a missing file (C:\\Users\\old\\gone.dll)",
      ),
    );
  });

  it("leaves an intact registration alone and rethrows", async () => {
    const exec = createExecFile({ regQuery: [registered] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80040154");

    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(regsvr32Calls(exec.calls)).toHaveLength(0);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("no registration self-heal"),
    );
  });

  it("falls back to the error-text trigger when the registry probe is unavailable", async () => {
    const healed = createExecFile({ regQuery: [probeBroken, probeBroken] });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: healed.execFile,
      }),
    ).resolves.toEqual({ started: true });
    expect(regsvr32Calls(healed.calls)).toHaveLength(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not be verified after regsvr32"),
    );

    __resetVcamRegistrationSelfHealForTesting();
    const untouched = createExecFile({ regQuery: [probeBroken] });
    const otherStart = jest.fn().mockRejectedValue(accessDeniedError);
    await expect(
      runVcamStartWithRegistrationSelfHeal(otherStart, {
        ...baseDeps(),
        execFile: untouched.execFile,
      }),
    ).rejects.toThrow("0x80070005");
    expect(regsvr32Calls(untouched.calls)).toHaveLength(0);
  });

  it("does not re-prompt after a failed heal in the same session", async () => {
    // regsvr32 "succeeds" but the registry stays empty: no retry, guard set.
    const exec = createExecFile({ regQuery: [missing, missing] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);
    const deps = { ...baseDeps(), execFile: exec.execFile };

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, deps),
    ).rejects.toThrow("0x80040154");
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, deps),
    ).rejects.toThrow("0x80040154");

    // Second call: guard set, so not even the probe runs again.
    expect(exec.calls.map((call) => call.file)).toEqual([
      "reg.exe",
      "powershell.exe",
      "reg.exe",
    ]);
    expect(startVcam).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("still not registered"),
    );
  });

  it("re-arms the guard after a verified heal with a working retry", async () => {
    const exec = createExecFile({
      regQuery: [missing, registered, missing, registered],
    });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true })
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });
    const deps = { ...baseDeps(), execFile: exec.execFile };

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, deps),
    ).resolves.toEqual({ started: true });
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, deps),
    ).resolves.toEqual({ started: true });
    expect(regsvr32Calls(exec.calls)).toHaveLength(2);
  });

  it("is a no-op on non-Windows platforms", async () => {
    const exec = createExecFile({ regQuery: [] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        platform: "darwin",
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80040154");

    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(exec.calls).toHaveLength(0);
  });

  it("skips with a warning when the packaged DLL is missing (dev run)", async () => {
    const exec = createExecFile({ regQuery: [missing] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(new Set()),
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80040154");

    expect(regsvr32Calls(exec.calls)).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("DLL not found"),
    );
  });

  it("maps regsvr32 exit codes and logs the admin command when registration fails", async () => {
    const exec = createExecFile({
      regQuery: [missing],
      regsvr32: execError("Command failed: powershell.exe", 5),
    });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80040154");

    // No retry after a failed registration.
    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "regsvr32 exit code 5: DllRegisterServer failed",
      ),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(`regsvr32 "${DLL_PATH}"`),
    );
  });

  it("surfaces a declined UAC prompt verbatim", async () => {
    const exec = createExecFile({
      regQuery: [missing],
      regsvr32: execError("The operation was canceled by the user.", 1),
    });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80040154");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("The operation was canceled by the user."),
    );
  });
});
