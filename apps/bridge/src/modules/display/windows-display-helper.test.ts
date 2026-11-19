import { EventEmitter } from "node:events";
import { setBridgeContext } from "../../services/bridge-context.js";
import {
  WINDOWS_LOADER_FAILURE_EXIT_CODES,
  WindowsDisplayHelperError,
  classifyWindowsHelperExitCode,
  listNativeWindowsDisplays,
  parseNativeWindowsDisplayList,
} from "./windows-display-helper.js";

const STATUS_DLL_NOT_FOUND = 3_221_225_781;

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const createMockChild = (): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
} => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
};

const HELPER_PATH =
  "C:\\Users\\customer\\AppData\\Local\\Programs\\Broadify Bridge\\resources\\native\\display-helper\\display-helper.exe";

const listWithSpawn = (
  spawnImplementation: (...args: unknown[]) => unknown,
): Promise<unknown> =>
  listNativeWindowsDisplays({
    spawn: jest.fn(spawnImplementation) as never,
    resolveHelperPath: () => HELPER_PATH,
    getHelperFileSize: () => 123_456,
  });

const createPayload = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    type: "display_list",
    version: 1,
    displays: [
      {
        device_name: "\\\\.\\DISPLAY2",
        monitor_device_path: "\\\\?\\DISPLAY#BMD0001#ATEM",
        friendly_name: "Blackmagic ATEM",
        adapter_luid: "00000000:00000042",
        target_id: 2,
        output_technology: 5,
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
        primary: false,
        modes: [
          {
            width: 1920,
            height: 1080,
            refresh_numerator: 60_000,
            refresh_denominator: 1_001,
            interlaced: false,
            preferred: true,
          },
        ],
        ...overrides,
      },
    ],
  });

describe("windows-display-helper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp/test",
      logger: mockLogger,
      logPath: "/tmp/test/bridge.log",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("maps native HDMI output and preserves fractional refresh rate", () => {
    const displays = parseNativeWindowsDisplayList(createPayload());

    expect(displays).toEqual([
      expect.objectContaining({
        name: "Blackmagic ATEM",
        connectionType: "hdmi",
        nativeSelector: "\\\\.\\DISPLAY2",
        resolution: { width: 1920, height: 1080 },
        modes: [
          expect.objectContaining({
            fps: 60_000 / 1_001,
            fieldDominance: "progressive",
            preferred: true,
          }),
        ],
      }),
    ]);
  });

  it("keeps the monitor ID stable when adapter and target IDs change", () => {
    const first = parseNativeWindowsDisplayList(createPayload())[0]?.stableId;
    const second = parseNativeWindowsDisplayList(
      createPayload({
        adapter_luid: "00000001:00000099",
        target_id: 7,
      }),
    )[0]?.stableId;

    expect(first).toMatch(/^win-[0-9a-f]{16}$/);
    expect(second).toBe(first);
  });

  it("filters internal display technology", () => {
    const displays = parseNativeWindowsDisplayList(
      createPayload({ output_technology: -2_147_483_648 }),
    );

    expect(displays).toEqual([]);
  });

  it("rejects helper payloads with a non-display selector", () => {
    expect(() =>
      parseNativeWindowsDisplayList(
        createPayload({ device_name: "C:\\Windows\\System32" }),
      ),
    ).toThrow();
  });

  it("rejects unknown fields instead of widening the helper contract", () => {
    expect(() =>
      parseNativeWindowsDisplayList(createPayload({ unexpected: true })),
    ).toThrow();
  });

  it("returns parsed displays after a successful helper spawn", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stdout.emit("data", Buffer.from(createPayload()));
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual([
      expect.objectContaining({ name: "Blackmagic ATEM" }),
    ]);
  });

  it("logs a synchronous spawn failure with sanitized diagnostics", async () => {
    const spawnError = Object.assign(new Error(`spawn ${HELPER_PATH} UNKNOWN`), {
      code: "UNKNOWN",
      errno: -4094,
      syscall: `spawn ${HELPER_PATH}`,
    });

    await expect(
      listWithSpawn(() => {
        throw spawnError;
      }),
    ).rejects.toThrow("spawn failed (code=UNKNOWN)");

    const logEntry = mockLogger.error.mock.calls[0]?.[0] as string;
    expect(logEntry).toContain('"code":"UNKNOWN"');
    expect(logEntry).toContain('"errno":-4094');
    expect(logEntry).toContain('"syscall":"spawn"');
    expect(logEntry).toContain(
      '"helper_path":"<resources>/native/display-helper/display-helper.exe"',
    );
    expect(logEntry).toContain('"helper_size_bytes":123456');
    expect(logEntry).toContain('"arguments":["--list-displays"]');
    expect(logEntry).not.toContain("customer");
  });

  it("rejects and logs an asynchronous spawn error event", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);
    const spawnError = Object.assign(new Error("loader rejected dependency"), {
      code: "UNKNOWN",
      errno: -4094,
      syscall: `spawn ${HELPER_PATH}`,
    });

    child.emit("error", spawnError);

    await expect(resultPromise).rejects.toThrow("spawn failed (code=UNKNOWN)");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("windows_display_helper_spawn_failed"),
    );
  });

  it("kills the helper and rejects on timeout", async () => {
    jest.useFakeTimers();
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    const rejection = expect(resultPromise).rejects.toThrow(
      "timed out after 2000ms",
    );
    await jest.advanceTimersByTimeAsync(2_000);

    await rejection;
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects a nonzero helper exit", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.emit("close", 7);

    await expect(resultPromise).rejects.toThrow("exited with code 7");
  });

  it("maps exit code 3221225781 to missing_runtime, logs a stderr excerpt and a readable message", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stderr.emit(
      "data",
      Buffer.from("The code execution cannot proceed because VCRUNTIME140.dll was not found."),
    );
    child.emit("close", STATUS_DLL_NOT_FOUND);

    await expect(resultPromise).rejects.toBeInstanceOf(WindowsDisplayHelperError);
    const error = (await resultPromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(error.kind).toBe("missing_runtime");
    expect(error.exitCode).toBe(STATUS_DLL_NOT_FOUND);
    expect(error.stderrExcerpt).toContain("VCRUNTIME140.dll");
    expect(error.message).toContain("STATUS_DLL_NOT_FOUND");
    expect(error.message).toContain("Visual C++");
    expect(error.message).toContain("vc_redist.x64");

    const logEntry = mockLogger.error.mock.calls[0]?.[0] as string;
    expect(logEntry).toContain('"event":"windows_display_helper_failed"');
    expect(logEntry).toContain('"kind":"missing_runtime"');
    expect(logEntry).toContain(`"exit_code":${STATUS_DLL_NOT_FOUND}`);
    expect(logEntry).toContain('"exit_code_hex":"0xC0000135"');
    expect(logEntry).toContain('"ntstatus":"STATUS_DLL_NOT_FOUND"');
    expect(logEntry).toContain("VCRUNTIME140.dll");
    expect(logEntry).toContain(
      '"helper_path":"<resources>/native/display-helper/display-helper.exe"',
    );
    expect(logEntry).not.toContain("customer");
  });

  it("treats other non-zero exits as helper_failed", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stderr.emit("data", Buffer.from("display enumeration failed"));
    child.emit("close", 7);

    const error = (await resultPromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(error).toBeInstanceOf(WindowsDisplayHelperError);
    expect(error.kind).toBe("helper_failed");
    expect(error.exitCode).toBe(7);
    expect(error.stderrExcerpt).toBe("display enumeration failed");
    expect(error.message).toContain("exited with code 7");
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('"kind":"helper_failed"'),
    );
  });

  it("caps buffered stderr at 8 KiB and truncates the logged excerpt", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stderr.emit("data", Buffer.alloc(10_000, "e"));
    child.emit("close", 1);

    const error = (await resultPromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(error.stderrExcerpt).toHaveLength(512);
    const logEntry = mockLogger.error.mock.calls[0]?.[0] as string;
    expect(logEntry.length).toBeLessThan(2_000);
  });

  it("maps a missing helper binary (ENOENT) to helper_missing", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.emit(
      "error",
      Object.assign(new Error(`spawn ${HELPER_PATH} ENOENT`), {
        code: "ENOENT",
        errno: -4058,
        syscall: `spawn ${HELPER_PATH}`,
      }),
    );

    const error = (await resultPromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(error).toBeInstanceOf(WindowsDisplayHelperError);
    expect(error.kind).toBe("helper_missing");
  });

  it("tags timeout, invalid response and oversized response errors with their kinds", async () => {
    jest.useFakeTimers();
    const timeoutChild = createMockChild();
    const timeoutErrorPromise = listWithSpawn(() => timeoutChild).catch(
      (e: unknown) => e,
    );
    await jest.advanceTimersByTimeAsync(2_000);
    const timeoutError = (await timeoutErrorPromise) as WindowsDisplayHelperError;
    expect(timeoutError.kind).toBe("timeout");
    jest.useRealTimers();

    const invalidChild = createMockChild();
    const invalidPromise = listWithSpawn(() => invalidChild);
    invalidChild.stdout.emit("data", Buffer.from("not-json"));
    invalidChild.emit("close", 0);
    const invalidError = (await invalidPromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(invalidError.kind).toBe("invalid_response");

    const largeChild = createMockChild();
    const largePromise = listWithSpawn(() => largeChild);
    largeChild.stdout.emit("data", Buffer.alloc(1_048_577, "x"));
    const largeError = (await largePromise.catch((e: unknown) => e)) as WindowsDisplayHelperError;
    expect(largeError.kind).toBe("response_too_large");
  });

  describe("classifyWindowsHelperExitCode", () => {
    it("classifies the known loader NTSTATUS codes as missing_runtime", () => {
      expect(classifyWindowsHelperExitCode(0xc0000135)).toBe("missing_runtime");
      expect(classifyWindowsHelperExitCode(3_221_225_781)).toBe("missing_runtime");
      expect(classifyWindowsHelperExitCode(0xc0000139)).toBe("missing_runtime");
      expect(classifyWindowsHelperExitCode(0xc0000142)).toBe("missing_runtime");
    });

    it("normalises a signed 32-bit representation of the loader code", () => {
      expect(classifyWindowsHelperExitCode(0xc0000135 | 0)).toBe("missing_runtime");
      expect(classifyWindowsHelperExitCode(-1_073_741_515)).toBe("missing_runtime");
    });

    it("classifies ordinary exits and unknown codes as helper_failed", () => {
      expect(classifyWindowsHelperExitCode(1)).toBe("helper_failed");
      expect(classifyWindowsHelperExitCode(7)).toBe("helper_failed");
      expect(classifyWindowsHelperExitCode(0xc0000005)).toBe("helper_failed");
      expect(classifyWindowsHelperExitCode(null)).toBe("helper_failed");
    });

    it("names the three loader failures", () => {
      expect(WINDOWS_LOADER_FAILURE_EXIT_CODES[0xc0000135]).toBe("STATUS_DLL_NOT_FOUND");
      expect(WINDOWS_LOADER_FAILURE_EXIT_CODES[0xc0000139]).toBe("STATUS_ENTRYPOINT_NOT_FOUND");
      expect(WINDOWS_LOADER_FAILURE_EXIT_CODES[0xc0000142]).toBe("STATUS_DLL_INIT_FAILED");
    });
  });

  it("rejects invalid helper JSON", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stdout.emit("data", Buffer.from("not-json"));
    child.emit("close", 0);

    await expect(resultPromise).rejects.toThrow(
      "Invalid native display helper response",
    );
  });

  it("kills the helper when its JSON response exceeds the size limit", async () => {
    const child = createMockChild();
    const resultPromise = listWithSpawn(() => child);

    child.stdout.emit("data", Buffer.alloc(1_048_577, "x"));

    await expect(resultPromise).rejects.toThrow("response too large");
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
