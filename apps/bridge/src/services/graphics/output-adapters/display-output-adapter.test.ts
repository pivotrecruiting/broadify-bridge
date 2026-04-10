import { EventEmitter } from "node:events";
import { DisplayVideoOutputAdapter } from "./display-output-adapter.js";

const mockLogger = {
  debug: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
};

jest.mock("../../bridge-context.js", () => ({
  getBridgeContext: () => ({ logger: mockLogger }),
}));

jest.mock("../../device-cache.js", () => ({
  deviceCache: { getDevices: jest.fn().mockResolvedValue([]) },
}));

jest.mock("../../../modules/display/display-helper.js", () => ({
  resolveDisplayHelperPath: () => "/tmp/display-helper",
}));

const mockAccess = jest.fn().mockResolvedValue(undefined);
jest.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
}));

let lastSpawnedChild: (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; kill: jest.Mock }) | null = null;

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

function createMockChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: string | null;
  kill: jest.Mock;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    exitCode: number | null;
    signalCode: string | null;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = jest.fn((signal?: string) => {
    child.exitCode = signal === "SIGKILL" ? 137 : 0;
    child.signalCode = signal ?? null;
    setImmediate(() => child.emit("exit", child.exitCode, child.signalCode));
  });
  return child;
}

function emitExit(
  child: { exitCode: number | null; signalCode: string | null; emit: (event: string, ...args: unknown[]) => boolean },
  code: number,
  signal: string | null
): void {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("exit", code, signal);
}

/** Use instead of mockReturnValue so afterEach can emit exit on the correct child. */
function setSpawnChild(
  child: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: string | null; kill: jest.Mock }
): void {
  lastSpawnedChild = child;
  mockSpawn.mockReturnValue(child);
}

const baseConfig = {
  version: 1,
  outputKey: "video_hdmi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

const validDisplayDevice = {
  id: "display-1",
  type: "display" as const,
  displayName: "Built-in Retina Display",
  ports: [
    {
      id: "display-1-hdmi",
      displayName: "HDMI",
      type: "hdmi" as const,
      direction: "output" as const,
      role: "video" as const,
      capabilities: {
        formats: [],
        modes: [{ id: 1, label: "1920x1080", width: 1920, height: 1080, fps: 60, fieldDominance: "progressive", pixelFormats: [] }],
      },
      status: { available: true },
    },
  ],
  status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
};

describe("DisplayVideoOutputAdapter", () => {
  let adapter: DisplayVideoOutputAdapter;
  const originalPlatform = process.platform;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    lastSpawnedChild = null;
    adapter = new DisplayVideoOutputAdapter();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    process.env = { ...originalEnv, BRIDGE_FRAMEBUS_NAME: "test-framebus" };
    const { deviceCache } = require("../../device-cache.js");
    deviceCache.getDevices.mockResolvedValue([]);
    mockSpawn.mockImplementation(() => {
      const child = createMockChild();
      lastSpawnedChild = child;
      return child;
    });
  });

  afterEach(async () => {
    if (lastSpawnedChild && lastSpawnedChild.exitCode === null && lastSpawnedChild.signalCode === null) {
      emitExit(lastSpawnedChild, 0, null);
    }
    await adapter.stop();
    lastSpawnedChild = null;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    process.env = originalEnv;
  });

  describe("configure", () => {
    it("throws when platform is not darwin or win32", async () => {
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-hdmi" },
        })
      ).rejects.toThrow("only supported on macOS and Windows");
    });

    it("throws when output1Id is missing", async () => {
      await expect(
        adapter.configure({ ...baseConfig, targets: {} })
      ).rejects.toThrow("Missing output port for Display video output");
    });

    it("throws when selected output is not a display device", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "decklink-1",
          type: "decklink",
          displayName: "DeckLink",
          ports: [{ id: "decklink-1-sdi", displayName: "SDI", type: "sdi", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("Selected output is not a display device");
    });

    it("throws when port ID does not exist in any device", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-1",
          type: "display",
          displayName: "Monitor",
          ports: [{ id: "display-1-hdmi", displayName: "HDMI", type: "hdmi", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "nonexistent-port-id" },
        })
      ).rejects.toThrow("Selected output is not a display device");
    });

    it("throws when port type is not HDMI/DisplayPort/Thunderbolt", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-1",
          type: "display",
          displayName: "Monitor",
          ports: [{ id: "display-1-usb", displayName: "USB", type: "usb", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-usb" },
        })
      ).rejects.toThrow("Display output requires HDMI/DisplayPort/Thunderbolt");
    });

    it("accepts DisplayPort port type", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-1",
          type: "display",
          displayName: "DP Monitor",
          ports: [
            {
              id: "display-1-displayport",
              displayName: "DisplayPort",
              type: "displayport",
              direction: "output",
              role: "video",
              capabilities: { formats: [], modes: [{ id: 1, label: "1920x1080", width: 1920, height: 1080, fps: 60, fieldDominance: "progressive", pixelFormats: [] }] },
              status: { available: true },
            },
          ],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-displayport" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await expect(configurePromise).resolves.toBeUndefined();
    });

    it("accepts Thunderbolt port type", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-1",
          type: "display",
          displayName: "TB Monitor",
          ports: [
            {
              id: "display-1-thunderbolt",
              displayName: "Thunderbolt",
              type: "thunderbolt",
              direction: "output",
              role: "video",
              capabilities: { formats: [], modes: [{ id: 1, label: "1920x1080", width: 1920, height: 1080, fps: 60, fieldDominance: "progressive", pixelFormats: [] }] },
              status: { available: true },
            },
          ],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-thunderbolt" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await expect(configurePromise).resolves.toBeUndefined();
    });

    it("throws when display helper binary is not accessible", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      mockAccess.mockRejectedValueOnce(new Error("ENOENT"));

      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-hdmi" },
        })
      ).rejects.toThrow("Display helper binary not found or inaccessible");
    });

    it("throws when BRIDGE_FRAMEBUS_NAME is not set", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      delete process.env.BRIDGE_FRAMEBUS_NAME;

      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "display-1-hdmi" },
        })
      ).rejects.toThrow("Native display helper requires BRIDGE_FRAMEBUS_NAME");
    });

    it("rejects when spawn emits error before ready", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      lastSpawnedChild = child;
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => child.emit("error", new Error("spawn ENOENT")));

      await expect(configurePromise).rejects.toThrow("spawn ENOENT");
    });

    it("rejects when helper exits before ready", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => emitExit(child, 1, null));

      await expect(configurePromise).rejects.toThrow("exited before ready");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Helper exited")
      );
    });

    it("configures successfully and spawns helper with correct args and env", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        "/tmp/display-helper",
        expect.arrayContaining([
          "--framebus-name",
          "test-framebus",
          "--width",
          "1920",
          "--height",
          "1080",
          "--fps",
          "30",
          "--display-index",
          "0",
        ]),
        expect.objectContaining({
          env: expect.objectContaining({
            BRIDGE_FRAMEBUS_NAME: "test-framebus",
            BRIDGE_FRAME_WIDTH: "1920",
            BRIDGE_FRAME_HEIGHT: "1080",
            BRIDGE_FRAME_FPS: "30",
            BRIDGE_DISPLAY_MATCH_NAME: "Built-in Retina Display",
            BRIDGE_DISPLAY_MATCH_WIDTH: "1920",
            BRIDGE_DISPLAY_MATCH_HEIGHT: "1080",
          }),
        })
      );
    });

    it("includes BRIDGE_FRAMEBUS_SIZE when set in env", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      process.env.BRIDGE_FRAMEBUS_SIZE = "4M";
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.BRIDGE_FRAMEBUS_SIZE).toBe("4M");
    });

    it("logs stderr output from helper", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stderr as EventEmitter).emit("data", Buffer.from("stderr warning\n"));
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockLogger.warn).toHaveBeenCalledWith("[DisplayOutput] stderr warning");
    });

    it("logs metrics and other message types via debug", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit(
          "data",
          Buffer.from('{"type":"metrics","fps":60}\n{"type":"other"}\n{"type":"ready"}\n')
        );
      });

      await configurePromise;

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('{"type":"metrics"')
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('{"type":"other"}')
      );
    });

    it("logs non-JSON stdout as warn", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from("not json\n"));
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Non-JSON output")
      );
    });

    it("skips empty lines in stdout and finds port in second device", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        {
          id: "display-0",
          type: "display",
          displayName: "Other",
          ports: [{ id: "display-0-hdmi", displayName: "HDMI", type: "hdmi", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
        validDisplayDevice,
      ]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit(
          "data",
          Buffer.from("\n\n  \n{\"type\":\"ready\"}\n")
        );
      });

      await configurePromise;

      expect(mockSpawn).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        expect.objectContaining({
          env: expect.objectContaining({
            BRIDGE_DISPLAY_MATCH_NAME: "Built-in Retina Display",
          }),
        })
      );
    });

    it("does not log when stderr is empty or whitespace only", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stderr as EventEmitter).emit("data", Buffer.from("   \n"));
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        expect.stringContaining("[DisplayOutput]")
      );
    });

    it("uses F_OK for helper access on win32", async () => {
      Object.defineProperty(process, "platform", { value: "win32", configurable: true });
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockAccess).toHaveBeenCalledWith("/tmp/display-helper", 0);
    });

    it("handles ready message split across data chunks", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"'));
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('ready"}\n'));
        });
      });

      await expect(configurePromise).resolves.toBeUndefined();
    });

    it("passes format dimensions and fps in env", async () => {
      const { deviceCache } = require("../../device-cache.js");
      const deviceWith4k = {
        ...validDisplayDevice,
        ports: [
          {
            ...validDisplayDevice.ports[0],
            capabilities: {
              formats: [],
              modes: [
                {
                  id: 2,
                  label: "3840x2160",
                  width: 3840,
                  height: 2160,
                  fps: 60,
                  fieldDominance: "progressive",
                  pixelFormats: [],
                },
              ],
            },
          },
        ],
      };
      deviceCache.getDevices.mockResolvedValue([deviceWith4k]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        format: { width: 3840, height: 2160, fps: 60 },
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      const spawnEnv = mockSpawn.mock.calls[0][2].env;
      expect(spawnEnv.BRIDGE_FRAME_WIDTH).toBe("3840");
      expect(spawnEnv.BRIDGE_FRAME_HEIGHT).toBe("2160");
      expect(spawnEnv.BRIDGE_FRAME_FPS).toBe("60");
      expect(spawnEnv.BRIDGE_DISPLAY_MATCH_WIDTH).toBe("3840");
      expect(spawnEnv.BRIDGE_DISPLAY_MATCH_HEIGHT).toBe("2160");
    });

    it("calls stop before reconfiguring when already configured", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child1 = createMockChild();
      setSpawnChild(child1);

      const configurePromise1 = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });
      setImmediate(() => {
        (child1.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise1;

      emitExit(child1, 0, null);

      const device2 = {
        id: "display-2",
        type: "display",
        displayName: "External",
        ports: [{ id: "display-2-hdmi", displayName: "HDMI", type: "hdmi", direction: "output", role: "video", capabilities: { formats: [], modes: [{ id: 1, label: "1920x1080", width: 1920, height: 1080, fps: 60, fieldDominance: "progressive", pixelFormats: [] }] }, status: { available: true } }],
        status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
      };
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice, device2]);
      const child2 = createMockChild();
      setSpawnChild(child2);

      const configurePromise2 = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-2-hdmi" },
      });
      setImmediate(() => {
        (child2.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise2;

      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn.mock.calls[1][2].env.BRIDGE_DISPLAY_MATCH_NAME).toBe("External");
    });

    it("finds port in first device when multiple devices exist", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([
        validDisplayDevice,
        {
          id: "display-2",
          type: "display",
          displayName: "External",
          ports: [{ id: "display-2-hdmi", displayName: "HDMI", type: "hdmi", direction: "output", role: "video", capabilities: { formats: [] }, status: { available: true } }],
          status: { present: true, ready: true, inUse: false, lastSeen: Date.now() },
        },
      ]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });

      await configurePromise;

      expect(mockSpawn.mock.calls[0][2].env.BRIDGE_DISPLAY_MATCH_NAME).toBe(
        "Built-in Retina Display"
      );
    });
  });

  describe("stop", () => {
    it("returns immediately when no child is running", async () => {
      await adapter.stop();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("is idempotent when called twice after configure", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise;

      const stopPromise1 = adapter.stop();
      setImmediate(() => emitExit(child, 0, null));
      await stopPromise1;

      await adapter.stop();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it("waits for child to exit and cleans up", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise;

      const stopPromise = adapter.stop();
      setImmediate(() => emitExit(child, 0, null));
      await stopPromise;

      expect(child.kill).not.toHaveBeenCalled();
    });

    it("sends SIGTERM then SIGKILL when child does not exit", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      child.kill = jest.fn((signal?: string) => {
        if (signal === "SIGKILL") {
          child.exitCode = 137;
          child.signalCode = "SIGKILL";
          setImmediate(() => child.emit("exit", 137, "SIGKILL"));
        }
      });
      lastSpawnedChild = child;
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise;

      jest.useFakeTimers();
      const stopPromise = adapter.stop();
      await jest.advanceTimersByTimeAsync(4100);
      await jest.advanceTimersByTimeAsync(2100);
      await stopPromise;
      jest.useRealTimers();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    });
  });

  describe("sendFrame", () => {
    it("is a no-op when never configured", async () => {
      await adapter.sendFrame(
        { rgba: Buffer.alloc(0), width: 0, height: 0, timestamp: 0 },
        baseConfig
      );
    });

    it("is a no-op when configured (FrameBus)", async () => {
      const { deviceCache } = require("../../device-cache.js");
      deviceCache.getDevices.mockResolvedValue([validDisplayDevice]);
      const child = createMockChild();
      setSpawnChild(child);

      const configurePromise = adapter.configure({
        ...baseConfig,
        targets: { output1Id: "display-1-hdmi" },
      });
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
      });
      await configurePromise;

      await expect(
        adapter.sendFrame(
          { rgba: Buffer.alloc(1920 * 1080 * 4), width: 1920, height: 1080, timestamp: 0 },
          baseConfig
        )
      ).resolves.toBeUndefined();
    });
  });
});
