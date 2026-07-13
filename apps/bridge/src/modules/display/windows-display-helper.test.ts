import { EventEmitter } from "node:events";
import { setBridgeContext } from "../../services/bridge-context.js";
import {
  listNativeWindowsDisplays,
  parseNativeWindowsDisplayList,
} from "./windows-display-helper.js";

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
