import { setBridgeContext } from "../bridge-context.js";
import {
  __resetVcamRegistrationSelfHealForTesting,
  buildElevatedRegsvr32Command,
  expandEnvironmentStrings,
  parseRegQueryDefaultValue,
  probeVcamRegistration,
  resolveRegsvr32Path,
  runVcamStartWithRegistrationSelfHeal,
  VCAM_CLSID,
  type ExecFileLikeT,
  type VcamSelfHealDepsT,
  type VcamSelfHealMarkerFsT,
} from "./vcam-registration-self-heal.js";

type ExecCallT = { file: string; args: string[] };

const DLL_PATH =
  "C:\\Program Files\\BroadifyBridge\\resources\\native\\vcam-helper\\broadify-vcam.dll";
const KEY_LINE = `HKEY_LOCAL_MACHINE\\SOFTWARE\\Classes\\CLSID\\${VCAM_CLSID}\\InprocServer32`;
const REG_QUERY_HIT = `\r\n${KEY_LINE}\r\n    (Default)    REG_SZ    ${DLL_PATH}\r\n\r\n`;
const REG_QUERY_HIT_DE = `\r\n${KEY_LINE}\r\n    (Standard)    REG_SZ    ${DLL_PATH}\r\n\r\n`;
const REG_QUERY_HIT_EXPAND = `\r\n${KEY_LINE}\r\n    (Standard)    REG_EXPAND_SZ    %ProgramFiles%\\BroadifyBridge\\resources\\native\\vcam-helper\\broadify-vcam.dll\r\n\r\n`;
const REG_QUERY_MISS_STDERR =
  "ERROR: The system was unable to find the specified registry key or value.\r\n";
const REG_QUERY_MISS_STDERR_DE =
  "FEHLER: Der angegebene Registrierungsschlüssel bzw. Wert wurde nicht gefunden.\r\n";
const WIN_ENV = { WINDIR: "C:\\Windows", ProgramFiles: "C:\\Program Files" };
const SYSNATIVE_REGSVR32 = "C:\\Windows\\Sysnative\\regsvr32.exe";
const SYSTEM32_REGSVR32 = "C:\\Windows\\System32\\regsvr32.exe";
const MARKER_PATH =
  "C:\\Users\\op\\AppData\\Roaming\\bridge\\vcam-self-heal.json";

const execError = (message: string, code?: number | string): Error =>
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

/** In-memory marker file store shared across simulated processes. */
const createMarkerFs = (files: Map<string, string>): VcamSelfHealMarkerFsT => ({
  readFileSync: (path) => {
    const body = files.get(path);
    if (body === undefined) {
      throw new Error(`ENOENT: ${path}`);
    }
    return body;
  },
  writeFileSync: (path, body) => {
    files.set(path, body);
  },
  unlinkSync: (path) => {
    files.delete(path);
  },
  mkdirSync: () => undefined,
});

const registered = { stdout: REG_QUERY_HIT };
const registeredDe = { stdout: REG_QUERY_HIT_DE };
const missing = {
  error: execError("Command failed: reg.exe query", 1),
  stderr: REG_QUERY_MISS_STDERR,
};
const missingDe = {
  error: execError("Command failed: reg.exe query", 1),
  stderr: REG_QUERY_MISS_STDERR_DE,
};
const probeBroken = { error: execError("spawn reg.exe ENOENT", "ENOENT") };

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

  let markerFiles: Map<string, string>;

  const baseDeps = (
    existing: Set<string> = new Set([DLL_PATH]),
  ): VcamSelfHealDepsT => ({
    existsSync: (path: string) => existing.has(path) || markerFiles.has(path),
    realpathSync: (path: string) => path,
    resolveDllPath: () => DLL_PATH,
    platform: "win32" as const,
    env: WIN_ENV,
    markerPath: MARKER_PATH,
    markerFs: createMarkerFs(markerFiles),
    appVersion: "1.2.3",
    now: () => 1_700_000_000_000,
  });

  const regsvr32Calls = (calls: ExecCallT[]): ExecCallT[] =>
    calls.filter((call) => call.file === "powershell.exe");

  beforeEach(() => {
    jest.clearAllMocks();
    markerFiles = new Map();
    __resetVcamRegistrationSelfHealForTesting();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
      publishBridgeEvent: jest.fn(),
    });
  });

  describe("parseRegQueryDefaultValue", () => {
    it("extracts the InprocServer32 default value regardless of the localized label", () => {
      expect(parseRegQueryDefaultValue(REG_QUERY_HIT)).toBe(DLL_PATH);
      expect(parseRegQueryDefaultValue(REG_QUERY_HIT_DE)).toBe(DLL_PATH);
      expect(
        parseRegQueryDefaultValue(
          `${KEY_LINE}\r\n    (Par défaut)    reg_sz    ${DLL_PATH}\r\n`,
        ),
      ).toBe(DLL_PATH);
      expect(parseRegQueryDefaultValue("")).toBeNull();
      expect(parseRegQueryDefaultValue(`${KEY_LINE}\r\n`)).toBeNull();
    });

    it("expands REG_EXPAND_SZ values against the environment (case-insensitive)", () => {
      expect(
        parseRegQueryDefaultValue(REG_QUERY_HIT_EXPAND, {
          programfiles: "C:\\Program Files",
        }),
      ).toBe(DLL_PATH);
      expect(expandEnvironmentStrings("%Unknown%\\x.dll", {})).toBe(
        "%Unknown%\\x.dll",
      );
    });
  });

  describe("probeVcamRegistration", () => {
    it("queries the 64-bit HKLM view and classifies registered/stale/missing", async () => {
      const hit = createExecFile({ regQuery: [registered, registered] });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: hit.execFile }),
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
          ...baseDeps(new Set()),
          execFile: hit.execFile,
        }),
      ).resolves.toEqual({
        state: "stale",
        dllPath: DLL_PATH,
        installedDllPath: DLL_PATH,
      });

      const miss = createExecFile({ regQuery: [missing] });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: miss.execFile }),
      ).resolves.toEqual({ state: "missing" });

      const broken = createExecFile({ regQuery: [probeBroken] });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: broken.execFile }),
      ).resolves.toEqual({
        state: "unknown",
        reason: "spawn reg.exe ENOENT",
      });
    });

    it("reads German reg.exe output as registered", async () => {
      const hit = createExecFile({ regQuery: [registeredDe] });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: hit.execFile }),
      ).resolves.toEqual({ state: "registered", dllPath: DLL_PATH });
    });

    it("expands a REG_EXPAND_SZ path and accepts it as registered", async () => {
      const hit = createExecFile({
        regQuery: [{ stdout: REG_QUERY_HIT_EXPAND }],
      });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: hit.execFile }),
      ).resolves.toEqual({ state: "registered", dllPath: DLL_PATH });
    });

    it("treats the German not-found error with exit code 1 as missing", async () => {
      const miss = createExecFile({ regQuery: [missingDe] });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: miss.execFile }),
      ).resolves.toEqual({ state: "missing" });
    });

    it("classifies unparseable output of a successful query as unknown, never missing", async () => {
      const garbage = createExecFile({
        regQuery: [
          { stdout: "Some unexpected\r\noutput without a type token\r\n" },
        ],
      });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: garbage.execFile }),
      ).resolves.toEqual({
        state: "unknown",
        reason: expect.stringContaining(
          "could not parse reg.exe output: Some unexpected output",
        ),
      });
    });

    it("classifies a non-1 exit code or output with a REG_ token as unknown with the raw output", async () => {
      const weird = createExecFile({
        regQuery: [
          {
            error: execError("Command failed", 2),
            stderr: "ERROR: access denied",
          },
          { error: execError("Command failed", 1), stdout: REG_QUERY_HIT_DE },
        ],
      });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: weird.execFile }),
      ).resolves.toEqual({
        state: "unknown",
        reason: "Command failed; output: ERROR: access denied",
      });
      await expect(
        probeVcamRegistration({ ...baseDeps(), execFile: weird.execFile }),
      ).resolves.toMatchObject({ state: "unknown" });
    });

    it("reports a registration pointing at a different existing DLL as stale with both paths", async () => {
      const otherDll =
        "C:\\Users\\old\\AppData\\Local\\Programs\\BroadifyBridge\\resources\\native\\vcam-helper\\broadify-vcam.dll";
      const hit = createExecFile({
        regQuery: [{ stdout: REG_QUERY_HIT.replace(DLL_PATH, otherDll) }],
      });
      await expect(
        probeVcamRegistration({
          ...baseDeps(new Set([DLL_PATH, otherDll])),
          execFile: hit.execFile,
        }),
      ).resolves.toEqual({
        state: "stale",
        dllPath: otherDll,
        installedDllPath: DLL_PATH,
      });
    });

    it("compares paths case-insensitively, normalized and via realpath", async () => {
      const shortPath =
        "C:\\PROGRA~1\\BroadifyBridge\\resources\\native\\vcam-helper\\BROADIFY-VCAM.DLL";
      const hit = createExecFile({
        regQuery: [
          { stdout: REG_QUERY_HIT.replace(DLL_PATH, shortPath) },
          { stdout: REG_QUERY_HIT.replace(DLL_PATH, DLL_PATH.toUpperCase()) },
        ],
      });
      const deps = {
        ...baseDeps(new Set([DLL_PATH, shortPath, DLL_PATH.toUpperCase()])),
        execFile: hit.execFile,
        realpathSync: (path: string) =>
          path.toLowerCase() === shortPath.toLowerCase() ? DLL_PATH : path,
      };
      await expect(probeVcamRegistration(deps)).resolves.toEqual({
        state: "registered",
        dllPath: shortPath,
      });
      await expect(probeVcamRegistration(deps)).resolves.toEqual({
        state: "registered",
        dllPath: DLL_PATH.toUpperCase(),
      });
    });
  });

  describe("resolveRegsvr32Path / buildElevatedRegsvr32Command", () => {
    it("pins Sysnative when present, else System32", () => {
      expect(
        resolveRegsvr32Path(WIN_ENV, (path) => path === SYSNATIVE_REGSVR32),
      ).toBe(SYSNATIVE_REGSVR32);
      expect(resolveRegsvr32Path(WIN_ENV, () => false)).toBe(
        SYSTEM32_REGSVR32,
      );
      expect(resolveRegsvr32Path({ windir: "D:\\Win" }, () => false)).toBe(
        "D:\\Win\\System32\\regsvr32.exe",
      );
    });

    it("quotes the paths for PowerShell and propagates the exit code", () => {
      expect(
        buildElevatedRegsvr32Command(SYSNATIVE_REGSVR32, "C:\\O'Neil\\a.dll"),
      ).toBe(
        `$p = Start-Process -FilePath '${SYSNATIVE_REGSVR32}' -ArgumentList '/s','C:\\O''Neil\\a.dll' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
      );
    });
  });

  it("registers a missing CLSID once via Sysnative regsvr32, verifies it and retries the start exactly once", async () => {
    const exec = createExecFile({ regQuery: [missing, registeredDe] });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(new Set([DLL_PATH, SYSNATIVE_REGSVR32])),
        execFile: exec.execFile,
      }),
    ).resolves.toEqual({ started: true });

    expect(startVcam).toHaveBeenCalledTimes(2);
    const elevated = regsvr32Calls(exec.calls);
    expect(elevated).toHaveLength(1);
    expect(elevated[0].args).toEqual([
      "-NoProfile",
      "-Command",
      `$p = Start-Process -FilePath '${SYSNATIVE_REGSVR32}' -ArgumentList '/s','${DLL_PATH}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode`,
    ]);
    expect(exec.calls.map((call) => call.file)).toEqual([
      "reg.exe",
      "powershell.exe",
      "reg.exe",
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("VCam DLL registered"),
    );
    // Verified heal: no marker is left behind.
    expect(markerFiles.size).toBe(0);
  });

  it("falls back to System32 regsvr32 when Sysnative does not exist", async () => {
    const exec = createExecFile({ regQuery: [missing, registered] });
    const startVcam = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });
    await runVcamStartWithRegistrationSelfHeal(startVcam, {
      ...baseDeps(),
      execFile: exec.execFile,
    });
    expect(regsvr32Calls(exec.calls)[0].args[2]).toContain(
      `-FilePath '${SYSTEM32_REGSVR32}'`,
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
        `CLSID points at C:\\Users\\old\\gone.dll instead of the installed ${DLL_PATH}`,
      ),
    );
  });

  it("leaves an intact registration alone and rethrows (German output)", async () => {
    const exec = createExecFile({ regQuery: [registeredDe] });
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

  it("never elevates on unparseable probe output unless the error itself reports 0x80040154", async () => {
    const garbage = { stdout: "Unerwartete Ausgabe\r\n" };
    const exec = createExecFile({ regQuery: [garbage] });
    const startVcam = jest.fn().mockRejectedValue(accessDeniedError);

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: exec.execFile,
      }),
    ).rejects.toThrow("0x80070005");

    expect(regsvr32Calls(exec.calls)).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "could not parse reg.exe output: Unerwartete Ausgabe",
      ),
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

  it("does not re-prompt after a failed heal in the same session and logs the raw verify output", async () => {
    // regsvr32 "succeeds" but the registry stays empty: no retry, guard set.
    const exec = createExecFile({ regQuery: [missing, missingDe] });
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
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        `installed=${DLL_PATH} reg.exe output="FEHLER: Der angegebene Registrierungsschlüssel bzw. Wert wurde nicht gefunden."`,
      ),
    );
    expect(JSON.parse(markerFiles.get(MARKER_PATH) ?? "{}")).toEqual({
      app_version: "1.2.3",
      dll_path: DLL_PATH,
      attempted_at: 1_700_000_000_000,
      outcome: "failed",
    });
  });

  it("does not prompt again in a new process when the marker records a failed heal for this install", async () => {
    const first = createExecFile({ regQuery: [missing, missing] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: first.execFile,
      }),
    ).rejects.toThrow("0x80040154");
    expect(regsvr32Calls(first.calls)).toHaveLength(1);

    // "Restart": fresh in-process state, same marker file on disk.
    __resetVcamRegistrationSelfHealForTesting();
    const second = createExecFile({ regQuery: [missing] });
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile: second.execFile,
      }),
    ).rejects.toThrow("0x80040154");
    expect(regsvr32Calls(second.calls)).toHaveLength(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /vcam_not_registered: .*already failed at 2023-11-14T22:13:20\.000Z, not prompting again\. Register manually from an elevated prompt: regsvr32 "C:\\Program Files/,
      ),
    );

    // A new app version (update re-registers the DLL) gets one more attempt.
    __resetVcamRegistrationSelfHealForTesting();
    const third = createExecFile({ regQuery: [missing, registered] });
    const healedStart = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });
    await expect(
      runVcamStartWithRegistrationSelfHeal(healedStart, {
        ...baseDeps(),
        execFile: third.execFile,
        appVersion: "1.2.4",
      }),
    ).resolves.toEqual({ started: true });
    expect(regsvr32Calls(third.calls)).toHaveLength(1);
    expect(markerFiles.size).toBe(0);
  });

  it("ignores a corrupt marker and writes a pending marker before the prompt opens", async () => {
    markerFiles.set(MARKER_PATH, "{not json");
    let markerDuringPrompt: string | undefined;
    const execFile: ExecFileLikeT = (file, _args, _options, callback) => {
      if (file === "reg.exe") {
        callback(missing.error, "", missing.stderr);
        return;
      }
      markerDuringPrompt = markerFiles.get(MARKER_PATH);
      callback(
        execError("The operation was canceled by the user.", 1),
        "",
        "",
      );
    };
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);
    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, {
        ...baseDeps(),
        execFile,
      }),
    ).rejects.toThrow("0x80040154");
    expect(JSON.parse(markerDuringPrompt ?? "{}")).toMatchObject({
      outcome: "pending",
    });
    expect(JSON.parse(markerFiles.get(MARKER_PATH) ?? "{}")).toMatchObject({
      outcome: "failed",
    });
  });

  it("never elevates from the unattended auto-arm path, even when the CLSID is missing", async () => {
    const exec = createExecFile({ regQuery: [missing, missing] });
    const startVcam = jest.fn().mockRejectedValue(classNotRegisteredError);
    const deps = {
      ...baseDeps(),
      execFile: exec.execFile,
      allowElevation: false,
    };

    await expect(
      runVcamStartWithRegistrationSelfHeal(startVcam, deps),
    ).rejects.toThrow("0x80040154");
    expect(regsvr32Calls(exec.calls)).toHaveLength(0);
    expect(startVcam).toHaveBeenCalledTimes(1);
    expect(markerFiles.size).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      `[Meeting] vcam_not_registered: CLSID is not registered in HKLM (64-bit view); unattended start never prompts for elevation. Register manually from an elevated prompt: regsvr32 "${DLL_PATH}"`,
    );

    // The diagnosis-only path does not consume the one explicit attempt.
    const explicit = createExecFile({ regQuery: [missing, registered] });
    const explicitStart = jest
      .fn()
      .mockRejectedValueOnce(classNotRegisteredError)
      .mockResolvedValueOnce({ started: true });
    await expect(
      runVcamStartWithRegistrationSelfHeal(explicitStart, {
        ...baseDeps(),
        execFile: explicit.execFile,
      }),
    ).resolves.toEqual({ started: true });
    expect(regsvr32Calls(explicit.calls)).toHaveLength(1);
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
    expect(markerFiles.size).toBe(0);
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
