import { EventEmitter } from "node:events";
import { setBridgeContext } from "../../services/bridge-context.js";
import { ModuleRegistry } from "../module-registry.js";
import {
  DEFAULT_DISPLAY_WATCH_INTERVAL_MS,
  DISPLAY_WATCH_INTERVAL_ENV,
  DisplayModule,
} from "./display-module.js";

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

type MockChildT = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
};

const createMockChild = (): MockChildT => {
  const child = new EventEmitter() as MockChildT;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
};

const display = (name: string): Record<string, unknown> => ({
  _name: name,
  spdisplays_connection_type: "HDMI",
  spdisplays_resolution: "1920 x 1080",
  spdisplays_refresh_rate: "60 Hz",
});

const profilerJson = (names: string[]): string =>
  JSON.stringify({
    SPDisplaysDataType: [
      { _items: [{ spdisplays_ndrvs: names.map((name) => display(name)) }] },
    ],
  });

/** Queue system_profiler outputs; each spawn consumes the next entry. */
const queueProfilerOutputs = (outputs: string[]): void => {
  mockSpawn.mockImplementation(() => {
    const child = createMockChild();
    const output = outputs.shift();
    setImmediate(() => {
      if (output === undefined) {
        child.emit("close", 2);
        return;
      }
      child.stdout.emit("data", Buffer.from(output));
      child.emit("close", 0);
    });
    return child;
  });
};

const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

const createFakeInterval = () => {
  let tickFn: (() => void) | null = null;
  const handle = { unref: jest.fn() };
  const setIntervalFn = jest.fn((fn: () => void) => {
    tickFn = fn;
    return handle;
  }) as unknown as typeof setInterval;
  const clearIntervalFn = jest.fn() as unknown as typeof clearInterval;
  return {
    handle,
    setIntervalFn,
    clearIntervalFn,
    tick: async (): Promise<void> => {
      tickFn?.();
      await flush();
    },
  };
};

describe("DisplayModule.watch", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env[DISPLAY_WATCH_INTERVAL_ENV];
    setBridgeContext({
      userDataDir: "/tmp/test",
      logger: mockLogger,
      logPath: "/tmp/test/bridge.log",
    });
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    process.env = originalEnv;
  });

  it("polls the module detect path and notifies the registry only when displays change", async () => {
    queueProfilerOutputs([
      profilerJson(["External Display"]),
      profilerJson(["External Display"]),
      profilerJson(["External Display", "RODECaster Video"]),
      profilerJson([]),
    ]);
    const timers = createFakeInterval();
    const module = new DisplayModule({
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const registry = new ModuleRegistry();
    registry.register(module);
    const onChange = jest.fn();

    const unsubscribe = registry.watchAll(onChange);
    await flush();
    expect(timers.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_DISPLAY_WATCH_INTERVAL_MS,
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    // The watch poll goes through the regular detect path, so diagnostics stay consistent.
    expect(module.getLastDiagnostics()).toEqual({ kind: "display", state: "ok" });

    await timers.tick();
    expect(onChange).not.toHaveBeenCalled();

    await timers.tick();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("display", [
      expect.objectContaining({ displayName: "External Display" }),
      expect.objectContaining({ displayName: "RODECaster Video" }),
    ]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("RODECaster Video"),
    );

    await timers.tick();
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith("display", []);
    expect(module.getLastDiagnostics()).toEqual({
      kind: "display",
      state: "no_devices",
    });

    unsubscribe();
    expect(timers.clearIntervalFn).toHaveBeenCalledWith(timers.handle);
  });

  it("logs a failing poll once per failure series and keeps the previous state", async () => {
    queueProfilerOutputs([
      profilerJson(["External Display"]),
      "not json {",
      "not json {",
      profilerJson(["External Display"]),
    ]);
    const timers = createFakeInterval();
    const module = new DisplayModule({
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });
    const callback = jest.fn();

    module.watch(callback);
    await flush();
    await timers.tick();
    await timers.tick();
    await timers.tick();

    expect(callback).not.toHaveBeenCalled();
    const pollWarnings = mockLogger.warn.mock.calls.filter(([message]) =>
      String(message).includes("[DisplayModule] Poll failed"),
    );
    expect(pollWarnings).toHaveLength(1);
    expect(mockSpawn).toHaveBeenCalledTimes(4);
  });

  it("honours BRIDGE_DISPLAY_WATCH_INTERVAL_MS and falls back with a warning when invalid", async () => {
    queueProfilerOutputs([profilerJson([]), profilerJson([])]);

    process.env[DISPLAY_WATCH_INTERVAL_ENV] = "30000";
    const valid = createFakeInterval();
    new DisplayModule({
      setIntervalFn: valid.setIntervalFn,
      clearIntervalFn: valid.clearIntervalFn,
    }).watch(jest.fn());
    await flush();
    expect(valid.setIntervalFn).toHaveBeenCalledWith(expect.any(Function), 30_000);
    expect(mockLogger.warn).not.toHaveBeenCalled();

    process.env[DISPLAY_WATCH_INTERVAL_ENV] = "100";
    const invalid = createFakeInterval();
    new DisplayModule({
      setIntervalFn: invalid.setIntervalFn,
      clearIntervalFn: invalid.clearIntervalFn,
    }).watch(jest.fn());
    await flush();
    expect(invalid.setIntervalFn).toHaveBeenCalledWith(
      expect.any(Function),
      DEFAULT_DISPLAY_WATCH_INTERVAL_MS,
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(DISPLAY_WATCH_INTERVAL_ENV),
    );
  });

  it("does not start a poll timer on unsupported platforms", () => {
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    const timers = createFakeInterval();
    const module = new DisplayModule({
      setIntervalFn: timers.setIntervalFn,
      clearIntervalFn: timers.clearIntervalFn,
    });

    const unsubscribe = module.watch(jest.fn());
    expect(timers.setIntervalFn).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});
