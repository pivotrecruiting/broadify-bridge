import { EventEmitter } from "node:events";
import { setBridgeContext } from "../../services/bridge-context.js";
import { DisplayModule } from "./display-module.js";

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

/** Windows PowerShell JSON: ids + connections. */
function windowsPowerShellJson(payload: {
  ids?: Array<{
    instance_name?: string;
    active?: boolean;
    name?: string;
    manufacturer?: string;
    product_code?: string;
    serial?: string;
  }>;
  connections?: Array<{
    instance_name?: string;
    active?: boolean;
    video_output_technology?: number;
  }>;
}): string {
  return JSON.stringify({
    ids: payload.ids ?? [],
    connections: payload.connections ?? [],
  });
}

/** WMIC csv output for Win32_DesktopMonitor. */
function wmicCsv(rows: Array<{ Name?: string; PNPDeviceID?: string; Status?: string }>): string {
  const header = "Node,Name,PNPDeviceID,Status";
  const lines = rows.map(
    (r) =>
      `"node","${r.Name ?? "Monitor"}","${r.PNPDeviceID ?? ""}","${r.Status ?? "OK"}"`
  );
  return [header, ...lines].join("\r\n");
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
    Object.defineProperty(process, "platform", {
      value: originalPlatform,
      configurable: true,
    });
    process.env = originalEnv;
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
        child.emit("close");
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
        child.emit("close");
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
        child.emit("close");
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
        child.emit("close");
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
        child.emit("close");
      });

      await detectPromise;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Missing connection type")
      );
    });

    it("on darwin returns empty array on system_profiler parse error", async () => {
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
        child.emit("close");
      });

      const result = await detectPromise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse system_profiler")
      );
    });

    it("on darwin returns empty array on spawn timeout", async () => {
      jest.useFakeTimers();
      Object.defineProperty(process, "platform", {
        value: "darwin",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const module = new DisplayModule();
      const detectPromise = module.detect();
      await jest.advanceTimersByTimeAsync(6000);
      const result = await detectPromise;
      expect(result).toEqual([]);
      jest.useRealTimers();
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
        child.emit("close");
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
        child.emit("close");
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("Nested Display");
    });

    it("on win32 returns devices from PowerShell when spawn succeeds", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const payload = windowsPowerShellJson({
        ids: [
          {
            instance_name: "DISPLAY\\MONITOR\\1234_5678_0",
            active: true,
            name: "DELL P2415Q",
            manufacturer: "DEL",
            product_code: "5678",
            serial: "ABC123",
          },
        ],
        connections: [
          {
            instance_name: "DISPLAY\\MONITOR\\1234_5678_0",
            active: true,
            video_output_technology: 5,
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("DELL P2415Q");
    });

    it("on win32 filters internal display by name", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const payload = windowsPowerShellJson({
        ids: [
          {
            instance_name: "DISPLAY\\MONITOR\\0_0_0",
            active: true,
            name: "Built-in Display",
          },
        ],
        connections: [{ instance_name: "DISPLAY\\MONITOR\\0_0_0", active: true }],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(0);
    });

    it("on win32 filters internal display by video_output_technology", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const payload = windowsPowerShellJson({
        ids: [
          {
            instance_name: "DISPLAY\\MONITOR\\0_0_0",
            active: true,
            name: "Generic PnP",
          },
        ],
        connections: [
          {
            instance_name: "DISPLAY\\MONITOR\\0_0_0",
            active: true,
            video_output_technology: -2147483648,
          },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(0);
    });

    it("on win32 falls back to displayport and warns when connection unknown", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const payload = windowsPowerShellJson({
        ids: [
          {
            instance_name: "DISPLAY\\MONITOR\\A_B_C",
            active: true,
            name: "Unknown Monitor",
          },
        ],
        connections: [
          { instance_name: "DISPLAY\\MONITOR\\A_B_C", active: true },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Missing/unknown Windows connection type")
      );
    });

    it("on win32 falls back to WMIC when PowerShell fails", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();

      setImmediate(() => {
        psChild.stdout.emit("data", "invalid json");
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              {
                Name: "Dell P2415Q",
                PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0",
                Status: "OK",
              },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Falling back to WMIC")
      );
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("Dell P2415Q");
    });

    it("on win32 WMIC filters non-DISPLAY PNPDeviceID and non-OK status", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              { Name: "Skip", PNPDeviceID: "USB\\VID_1234", Status: "OK" },
              { Name: "OK Display", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
              { Name: "Bad Status", PNPDeviceID: "DISPLAY\\BAD&0000&0000\\0", Status: "Degraded" },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("OK Display");
    });

    it("on win32 PowerShell timeout returns empty then WMIC can still provide displays", async () => {
      jest.useFakeTimers();
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      await jest.advanceTimersByTimeAsync(6000);
      await Promise.resolve();
      jest.useRealTimers();
      setImmediate(() => {
        wmicChild.stdout.emit(
          "data",
          wmicCsv([
            { Name: "WMIC Monitor", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
          ])
        );
        wmicChild.emit("close", 0);
      });
      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("WMIC Monitor");
    }, 15000);

    it("on win32 PowerShell process error triggers WMIC fallback", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("error", new Error("spawn ENOENT"));
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              { Name: "WMIC Fallback", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to run PowerShell")
      );
    });

    it("on win32 PowerShell exit code non-zero with empty stdout resolves with reason", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.stderr.emit("data", "Execution policy error");
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([{ Name: "W", PNPDeviceID: "DISPLAY\\A&1&2\\0", Status: "OK" }])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("PowerShell exited")
      );
      expect(result.length).toBe(1);
    });

    it("on win32 handles missing ids/connections (toObjectArray undefined)", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockImplementation(() => child);

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", "{}");
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result).toEqual([]);
    });

    it("on win32 skips id and connection rows with active false", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockImplementation(() => child);

      const payload = windowsPowerShellJson({
        ids: [
          {
            instance_name: "DISPLAY\\MONITOR\\1_2_0",
            active: false,
            name: "Inactive Monitor",
          },
          {
            instance_name: "DISPLAY\\MONITOR\\2_3_0",
            active: true,
            name: "Active Monitor",
          },
        ],
        connections: [
          { instance_name: "DISPLAY\\MONITOR\\2_3_0", active: false },
          { instance_name: "DISPLAY\\MONITOR\\2_3_0", active: true, video_output_technology: 10 },
        ],
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
      expect(result[0].displayName).toBe("Active Monitor");
    });

    it("on win32 toObjectArray normalizes single id/connection object to array", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const child = createMockChild();
      mockSpawn.mockImplementation(() => child);

      const singleId = {
        instance_name: "DISPLAY\\MONITOR\\1_2_0",
        active: true,
        name: "Single Monitor",
      };
      const singleConn = {
        instance_name: "DISPLAY\\MONITOR\\1_2_0",
        active: true,
        video_output_technology: 10,
      };
      const payload = JSON.stringify({ ids: singleId, connections: singleConn });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        child.stdout.emit("data", payload);
        child.emit("close", 0);
      });

      const result = await detectPromise;
      expect(result).toHaveLength(1);
      expect(result[0].displayName).toBe("Single Monitor");
    });

    it("on win32 WMIC returns empty when CSV has no valid DISPLAY rows", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit("data", "Node,Name,PNPDeviceID,Status\r\n");
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(result).toEqual([]);
    });

    it("on win32 WMIC logs fallback warn when results length > 0", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              { Name: "Dell 1", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
              { Name: "Dell 2", PNPDeviceID: "DISPLAY\\DEL&1234&5679\\0", Status: "OK" },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      await detectPromise;
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Windows display detection used WMIC fallback")
      );
    });

    it("on win32 WMIC skips duplicate name|pnpDeviceId", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              { Name: "Same", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
              { Name: "Same", PNPDeviceID: "DISPLAY\\DEL&1234&5678\\0", Status: "OK" },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(result.length).toBe(1);
    });

    it("on win32 WMIC logs when exit code non-zero and stdout empty", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stderr.emit("data", "Access denied");
          wmicChild.emit("close", 1);
        });
      });

      const result = await detectPromise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("WMIC exited with code")
      );
    });

    it("on win32 WMIC process error returns empty array", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => wmicChild.emit("error", new Error("wmic not found")));
      });

      const result = await detectPromise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to run WMIC")
      );
    });

    it("on win32 WMIC filters internal by name", async () => {
      Object.defineProperty(process, "platform", {
        value: "win32",
        configurable: true,
      });
      const psChild = createMockChild();
      const wmicChild = createMockChild();
      mockSpawn.mockImplementation((cmd: string) => {
        if (typeof cmd === "string" && (cmd.endsWith("wmic.exe") || cmd === "wmic")) {
          return wmicChild;
        }
        return psChild;
      });

      const module = new DisplayModule();
      const detectPromise = module.detect();
      setImmediate(() => {
        psChild.emit("close", 1);
        setImmediate(() => {
          wmicChild.stdout.emit(
            "data",
            wmicCsv([
              { Name: "Integrated Display", PNPDeviceID: "DISPLAY\\INT&0&0\\0", Status: "OK" },
              { Name: "External", PNPDeviceID: "DISPLAY\\EXT&1234&5678\\0", Status: "OK" },
            ])
          );
          wmicChild.emit("close", 0);
        });
      });

      const result = await detectPromise;
      expect(result).toHaveLength(1);
      expect(result[0].displayName).toBe("External");
    });

    it("on win32 uses System32 path when module loaded with SystemRoot set", async () => {
      jest.resetModules();
      const { setBridgeContext: setCtx } = await import("../../services/bridge-context.js");
      setCtx({
        userDataDir: "/tmp/test",
        logger: mockLogger,
        logPath: "/tmp/test/bridge.log",
      });
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      process.env.SystemRoot = "C:\\Windows";
      const { DisplayModule: DM } = await import("./display-module.js");
      const child = createMockChild();
      mockSpawn.mockImplementation(() => child);

      const mod = new DM();
      const detectPromise = mod.detect();
      setImmediate(() => {
        child.stdout.emit(
          "data",
          windowsPowerShellJson({ ids: [], connections: [] })
        );
        child.emit("close", 0);
      });
      await detectPromise;

      const firstSpawnCmd = mockSpawn.mock.calls[0]?.[0];
      expect(typeof firstSpawnCmd).toBe("string");
      expect((firstSpawnCmd as string).toLowerCase()).toContain("system32");
    });

    it("on win32 uses powershell.exe fallback when module loaded without SystemRoot", async () => {
      jest.resetModules();
      const { setBridgeContext: setCtx } = await import("../../services/bridge-context.js");
      setCtx({
        userDataDir: "/tmp/test",
        logger: mockLogger,
        logPath: "/tmp/test/bridge.log",
      });
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      delete process.env.SystemRoot;
      delete process.env.WINDIR;
      const { DisplayModule: DM } = await import("./display-module.js");
      const child = createMockChild();
      mockSpawn.mockImplementation(() => child);

      const mod = new DM();
      const detectPromise = mod.detect();
      setImmediate(() => {
        child.stdout.emit(
          "data",
          windowsPowerShellJson({ ids: [], connections: [] })
        );
        child.emit("close", 0);
      });
      await detectPromise;

      const firstSpawnCmd = mockSpawn.mock.calls[0]?.[0];
      expect(firstSpawnCmd).toBe("powershell.exe");
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
