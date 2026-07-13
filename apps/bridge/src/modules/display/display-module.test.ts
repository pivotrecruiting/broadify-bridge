import { EventEmitter } from "node:events";
import { setBridgeContext } from "../../services/bridge-context.js";
import { DeviceCache } from "../../services/device-cache.js";
import { ModuleRegistry } from "../module-registry.js";
import { DisplayModule } from "./display-module.js";
import { displayTargetRegistry } from "./display-target-registry.js";

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

function createMockChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

/** Minimal macOS system_profiler JSON: one external display. */
function macOsDisplayJson(overrides: Record<string, unknown> = {}): string {
  const base = {
    SPDisplaysDataType: [
      {
        _items: [
          {
            spdisplays_ndrvs: [
              {
                _name: "External Display",
                spdisplays_connection_type: "DisplayPort",
                spdisplays_resolution: "3840 x 2160",
                spdisplays_refresh_rate: "60 Hz",
                "spdisplays_display_vendor-id": "0x1234",
                "spdisplays_display_product-id": "0x5678",
                "spdisplays_display_serial-number": "SN123",
              },
            ],
          },
        ],
      },
    ],
  };
  return JSON.stringify(
    typeof overrides.SPDisplaysDataType !== "undefined"
      ? overrides
      : { ...base, ...overrides }
  );
}

function nativeWindowsDisplayJson(): string {
  return JSON.stringify({
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
      },
    ],
  });
}

describe("DisplayModule", () => {
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp/test",
      logger: mockLogger,
      logPath: "/tmp/test/bridge.log",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    process.env = originalEnv;
    displayTargetRegistry.clear();
  });

  describe("name", () => {
    it("exposes module name display", () => {
      const module = new DisplayModule();
      expect(module.name).toBe("display");
    });
  });

  describe("detect", () => {
    it("returns empty array on unsupported platform (linux)", async () => {
      Object.defineProperty(process, "platform", {
        value: "linux",
        configurable: true,
      });
      const module = new DisplayModule();
      const result = await module.detect();
      expect(result).toEqual([]);
    });

    it("on darwin returns devices from system_profiler when spawn succeeds", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const module = new DisplayModule();
      const detectPromise = module.detect();

      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(macOsDisplayJson()));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(mockSpawn).toHaveBeenCalledWith("system_profiler", [
        "SPDisplaysDataType",
        "-json",
      ]);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe("display");
      expect(result[0].displayName).toContain("External");
      expect(result[0].ports?.length).toBeGreaterThan(0);
    });

    it("on darwin filters out internal display by name when display_type missing", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = macOsDisplayJson({
        SPDisplaysDataType: [
          {
            _items: [
              {
                spdisplays_ndrvs: [
                  {
                    _name: "Internal Display",
                    spdisplays_connection_type: "Internal",
                    spdisplays_resolution: "1920 x 1080",
                    spdisplays_refresh_rate: "60 Hz",
                  },
                ],
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(0);
    });

    it("on darwin filters out internal displays (display_type built-in)", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = macOsDisplayJson({
        SPDisplaysDataType: [
          {
            _items: [
              {
                spdisplays_ndrvs: [
                  {
                    spdisplays_display_type: "Built-in",
                    _name: "Built-in Retina",
                    spdisplays_connection_type: "Internal",
                    spdisplays_resolution: "1920 x 1080",
                    spdisplays_refresh_rate: "60 Hz",
                  },
                  {
                    _name: "External",
                    spdisplays_connection_type: "DisplayPort",
                    spdisplays_resolution: "1920 x 1080",
                    spdisplays_refresh_rate: "60 Hz",
                  },
                ],
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("External");
    });

    it("on darwin uses findStringMatch for connection when key missing", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = macOsDisplayJson({
        SPDisplaysDataType: [
          {
            _items: [
              {
                spdisplays_ndrvs: [
                  {
                    _name: "LG HDMI",
                    unknown_connection: "HDMI",
                    some_resolution: "1920 x 1080",
                    some_freq: "60 Hz",
                  },
                ],
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].ports?.some((p) => p.type === "hdmi")).toBe(true);
    });

    it("on darwin falls back to displayport and warns when connection unknown", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = macOsDisplayJson({
        SPDisplaysDataType: [
          {
            _items: [
              {
                spdisplays_ndrvs: [
                  {
                    _name: "Unknown Connector",
                    spdisplays_resolution: "1920 x 1080",
                    spdisplays_refresh_rate: "60 Hz",
                  },
                ],
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      await detectPromise;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Missing connection type")
      );
    });

    it("on darwin rejects a system_profiler parse error", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", "not json {");
        child.emit("close", 0);
      });

      await expect(detectPromise).rejects.toThrow(
        "Failed to parse system_profiler output",
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse system_profiler")
      );
    });

    it("on darwin kills system_profiler and rejects on timeout", async () => {
      jest.useFakeTimers();
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const module = new DisplayModule();
      const detectPromise = module.detect();
      const rejection = expect(detectPromise).rejects.toThrow(
        "system_profiler timed out after 5000ms",
      );
      await jest.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      jest.useRealTimers();
    });

    it("on darwin rejects a system_profiler spawn error", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const detectPromise = new DisplayModule().detect();
      child.emit("error", new Error("spawn EACCES"));

      await expect(detectPromise).rejects.toThrow(
        "system_profiler spawn failed: spawn EACCES",
      );
    });

    it("on darwin rejects a nonzero system_profiler exit", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const detectPromise = new DisplayModule().detect();
      child.emit("close", 2);

      await expect(detectPromise).rejects.toThrow(
        "system_profiler exited with code 2",
      );
    });

    it("uses a module timeout longer than the system_profiler timeout", () => {
      expect(new DisplayModule().detectionTimeoutMs).toBe(6_000);
    });

    it("on darwin collectDisplays skips non-object nodes", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = JSON.stringify({
        SPDisplaysDataType: [
          null,
          "string",
          {
            spdisplays_ndrvs: [
              {
                _name: "Valid Display",
                spdisplays_connection_type: "HDMI",
                spdisplays_resolution: "1920 x 1080",
                spdisplays_refresh_rate: "60 Hz",
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("Valid Display");
    });

    it("on darwin handles nested _items in collectDisplays", async () => {
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const json = JSON.stringify({
        SPDisplaysDataType: [
          {
            _items: [
              {
                _items: [
                  {
                    spdisplays_ndrvs: [
                      {
                        _name: "Nested Display",
                        spdisplays_connection_type: "Thunderbolt",
                        spdisplays_resolution: "2560 x 1440",
                        spdisplays_refresh_rate: "60 Hz",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(json));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("Nested Display");
    });

    it("on win32 uses the native helper and returns exact modes", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", Buffer.from(nativeWindowsDisplayJson()));
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(mockSpawn).toHaveBeenCalledWith(
        expect.stringContaining("display-helper"),
        ["--list-displays"],
        expect.objectContaining({ windowsHide: true }),
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        displayName: "Blackmagic ATEM",
        type: "display",
        ports: [
          expect.objectContaining({
            type: "hdmi",
            capabilities: expect.objectContaining({
              modes: [
                expect.objectContaining({
                  width: 1920,
                  height: 1080,
                  fps: 60_000 / 1_001,
                }),
              ],
            }),
          }),
        ],
      });
      expect(
        displayTargetRegistry.resolve(result[0].ports[0].id),
      ).toEqual({ deviceName: "\\\\.\\DISPLAY2" });
    });

    it("preserves the last valid macOS output across a parse failure and clears it after a valid disconnect", async () => {
      jest.spyOn(console, "error").mockImplementation(() => undefined);
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const profilerOutputs = [
        macOsDisplayJson(),
        macOsDisplayJson().replace("External Display", "Updated Display"),
        "not json {",
        macOsDisplayJson({ SPDisplaysDataType: [] }),
      ];
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        const output = profilerOutputs.shift();
        setImmediate(() => {
          child.stdout.emit("data", Buffer.from(output ?? ""));
          child.emit("close", 0);
        });
        return child;
      });

      const registry = new ModuleRegistry();
      registry.register(new DisplayModule());
      const cache = new DeviceCache({
        moduleRegistry: registry,
        getLogger: () => mockLogger,
        refreshRateLimitMs: 0,
      });

      const first = await cache.getDevices();
      const second = await cache.getDevices(true);
      const afterParseFailure = await cache.getDevices(true);
      const afterDisconnect = await cache.getDevices(true);

      expect(first).toEqual([
        expect.objectContaining({ displayName: "External Display" }),
      ]);
      expect(second).toEqual([
        expect.objectContaining({ displayName: "Updated Display" }),
      ]);
      expect(afterParseFailure).toEqual(second);
      expect(afterDisconnect).toEqual([]);
      expect(mockSpawn).toHaveBeenCalledTimes(4);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("preserving 1 cached device"),
      );
    });

  });

  describe("createController", () => {
    it("returns controller with open, close, getStatus", () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      expect(controller).toBeDefined();
      expect(typeof controller.open).toBe("function");
      expect(typeof controller.close).toBe("function");
      expect(typeof controller.getStatus).toBe("function");
    });

    it("getStatus returns present status", async () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      const status = await controller.getStatus();
      expect(status.present).toBe(true);
      expect(status.ready).toBe(true);
      expect(typeof status.lastSeen).toBe("number");
    });

    it("open and close log without throwing", async () => {
      const module = new DisplayModule();
      const controller = module.createController("display-1");
      await expect(controller.open()).resolves.toBeUndefined();
      await expect(controller.close()).resolves.toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Open requested")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Close requested")
      );
    });
  });
});
