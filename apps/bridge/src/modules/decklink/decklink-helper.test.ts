import { EventEmitter } from "node:events";
import path from "node:path";

const mockSpawn = jest.fn();
const mockAccess = jest.fn();
const mockAccessSync = jest.fn();
const mockPlatform = jest.fn();
const mockGetBridgeContext = jest.fn();

jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

jest.mock("node:fs/promises", () => ({
  access: (...args: unknown[]) => mockAccess(...args),
}));

jest.mock("node:fs", () => ({
  ...jest.requireActual("node:fs"),
  accessSync: (...args: unknown[]) => mockAccessSync(...args),
}));

jest.mock("node:os", () => ({
  platform: () => mockPlatform(),
}));

jest.mock("../../services/bridge-context.js", () => ({
  getBridgeContext: () => mockGetBridgeContext(),
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

describe("decklink-helper", () => {
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetBridgeContext.mockReturnValue({ logger: mockLogger });
    mockPlatform.mockReturnValue("darwin");
    mockAccess.mockResolvedValue(undefined);
    mockAccessSync.mockReturnValue(undefined);
    delete process.env.DECKLINK_HELPER_PATH;
    const { __setDecklinkHelperPathForTesting } = require("./decklink-helper.js");
    __setDecklinkHelperPathForTesting("/fake/helper/path");
  });

  afterEach(() => {
    const { __setDecklinkHelperPathForTesting } = require("./decklink-helper.js");
    __setDecklinkHelperPathForTesting(null);
  });

  describe("resolveDecklinkHelperPath", () => {
    it("returns DECKLINK_HELPER_PATH when set", () => {
      process.env.DECKLINK_HELPER_PATH = "/env/helper/path";
      const { __setDecklinkHelperPathForTesting, resolveDecklinkHelperPath } =
        require("./decklink-helper.js");
      __setDecklinkHelperPathForTesting(null);
      expect(resolveDecklinkHelperPath()).toBe("/env/helper/path");
    });

    it("returns test override when set", () => {
      const { resolveDecklinkHelperPath } = require("./decklink-helper.js");
      expect(resolveDecklinkHelperPath()).toBe("/fake/helper/path");
    });

    it("returns dev or prod path when no override and no env", () => {
      const { __setDecklinkHelperPathForTesting, resolveDecklinkHelperPath } =
        require("./decklink-helper.js");
      __setDecklinkHelperPathForTesting(null);
      delete process.env.DECKLINK_HELPER_PATH;
      const result = resolveDecklinkHelperPath();
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain("decklink-helper");
    });

    it("returns production path when NODE_ENV is production and resourcesPath exists", () => {
      const { __setDecklinkHelperPathForTesting, resolveDecklinkHelperPath } =
        require("./decklink-helper.js");
      __setDecklinkHelperPathForTesting(null);
      delete process.env.DECKLINK_HELPER_PATH;
      const origEnv = process.env.NODE_ENV;
      const origResources = (process as { resourcesPath?: string }).resourcesPath;
      (process as { resourcesPath?: string }).resourcesPath = "/app/resources";
      process.env.NODE_ENV = "production";

      const result = resolveDecklinkHelperPath();
      expect(result).toBe(
        path.join("/app/resources", "native", "decklink-helper", "decklink-helper")
      );

      process.env.NODE_ENV = origEnv;
      (process as { resourcesPath?: string }).resourcesPath = origResources;
    });
  });

  describe("listDecklinkDevices", () => {
    it("returns empty array on non-darwin platform", async () => {
      mockPlatform.mockReturnValue("win32");
      const { listDecklinkDevices } = require("./decklink-helper.js");
      const result = await listDecklinkDevices();
      expect(result).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns empty array when helper is not executable", async () => {
      mockAccess.mockRejectedValue(new Error("ENOENT"));
      const { listDecklinkDevices } = require("./decklink-helper.js");
      const result = await listDecklinkDevices();
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Helper not found or not executable")
      );
    });

    it("returns devices when helper outputs valid JSON array", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDevices } = require("./decklink-helper.js");
      const promise = listDecklinkDevices();

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", Buffer.from(JSON.stringify([{ id: "decklink-1" }])));
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result).toEqual([{ id: "decklink-1" }]);
      expect(mockSpawn).toHaveBeenCalledWith(
        "/fake/helper/path",
        ["--list"],
        expect.any(Object)
      );
    });

    it("returns empty array when helper exits with non-zero code", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDevices } = require("./decklink-helper.js");
      const promise = listDecklinkDevices();

      setImmediate(() => {
        (child.stderr as EventEmitter).emit("data", "error message");
        child.emit("close", 1);
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Helper exited with code 1")
      );
    });

    it("returns empty array when helper output is invalid JSON", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDevices } = require("./decklink-helper.js");
      const promise = listDecklinkDevices();

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", "not json");
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse helper output")
      );
    });

    it("wraps non-array JSON in empty array", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDevices } = require("./decklink-helper.js");
      const promise = listDecklinkDevices();

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", JSON.stringify({ not: "array" }));
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result).toEqual([]);
    });

    it("returns empty array when spawn emits error", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDevices } = require("./decklink-helper.js");
      const promise = listDecklinkDevices();

      setImmediate(() => {
        child.emit("error", new Error("spawn failed"));
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start helper")
      );
    });
  });

  describe("listDecklinkDisplayModes", () => {
    it("returns empty array on non-darwin platform", async () => {
      mockPlatform.mockReturnValue("linux");
      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const result = await listDecklinkDisplayModes("dev-1", "port-1");
      expect(result).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns empty array when helper is not executable", async () => {
      mockAccess.mockRejectedValue(new Error("EACCES"));
      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const result = await listDecklinkDisplayModes("dev-1", "port-1");
      expect(result).toEqual([]);
    });

    it("calls helper with device and output-port args", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("decklink-1", "sdi");

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", JSON.stringify([]));
        child.emit("close", 0);
      });

      await promise;
      expect(mockSpawn).toHaveBeenCalledWith(
        "/fake/helper/path",
        ["--list-modes", "--device", "decklink-1", "--output-port", "sdi"],
        expect.any(Object)
      );
    });

    it("adds query params when provided", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("dev-1", "port-1", {
        width: 1920,
        height: 1080,
        fps: 60,
        requireKeying: true,
      });

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", JSON.stringify([]));
        child.emit("close", 0);
      });

      await promise;
      expect(mockSpawn).toHaveBeenCalledWith(
        "/fake/helper/path",
        [
          "--list-modes",
          "--device",
          "dev-1",
          "--output-port",
          "port-1",
          "--width",
          "1920",
          "--height",
          "1080",
          "--fps",
          "60",
          "--keying",
        ],
        expect.any(Object)
      );
    });

    it("returns display modes from helper output", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);
      const modes = [
        {
          name: "1080p60",
          id: 1,
          width: 1920,
          height: 1080,
          fps: 60,
          frameDuration: 1,
          timeScale: 60,
          fieldDominance: "progressive",
          connection: "sdi",
          pixelFormats: ["8bit"],
        },
      ];

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("dev-1", "port-1");

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", JSON.stringify(modes));
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result).toEqual(modes);
    });

    it("returns empty array when list-modes exits with non-zero", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("dev-1", "port-1");

      setImmediate(() => {
        (child.stderr as EventEmitter).emit("data", "device not found");
        child.emit("close", 1);
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("list-modes exited with code 1")
      );
    });

    it("returns empty array when list-modes output is invalid JSON", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("dev-1", "port-1");

      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", "not valid json");
        child.emit("close", 0);
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to parse list-modes output")
      );
    });

    it("returns empty array when list-modes spawn emits error", async () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { listDecklinkDisplayModes } = require("./decklink-helper.js");
      const promise = listDecklinkDisplayModes("dev-1", "port-1");

      setImmediate(() => {
        child.emit("error", new Error("spawn ENOENT"));
      });

      const result = await promise;
      expect(result).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to start list-modes")
      );
    });
  });

  describe("watchDecklinkDevices", () => {
    it("returns no-op unsubscribe on non-darwin platform", () => {
      mockPlatform.mockReturnValue("win32");
      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      const unsubscribe = watchDecklinkDevices(onEvent);
      expect(typeof unsubscribe).toBe("function");
      expect(unsubscribe()).toBeUndefined();
      expect(mockSpawn).not.toHaveBeenCalled();
    });

    it("returns no-op when helper path is empty and logs warn", () => {
      const { __setDecklinkHelperPathForTesting, watchDecklinkDevices } =
        require("./decklink-helper.js");
      __setDecklinkHelperPathForTesting("");
      const onEvent = jest.fn();
      const unsubscribe = watchDecklinkDevices(onEvent);
      expect(unsubscribe()).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Unable to resolve helper path")
      );
    });

    it("returns no-op when helper is not executable", () => {
      mockAccessSync.mockImplementation(() => {
        throw new Error("ENOENT");
      });
      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      const unsubscribe = watchDecklinkDevices(onEvent);
      expect(unsubscribe()).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Helper not found or not executable")
      );
    });

    it("spawns watch process and invokes onEvent for each JSON line", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      const unsubscribe = watchDecklinkDevices(onEvent);

      expect(mockSpawn).toHaveBeenCalledWith(
        "/fake/helper/path",
        ["--watch"],
        expect.any(Object)
      );

      const event1 = { type: "devices", devices: [] };
      (child.stdout as EventEmitter).emit("data", JSON.stringify(event1) + "\n");
      expect(onEvent).toHaveBeenCalledWith(event1);

      const event2 = { type: "device_added", devices: [{ id: "1" }] };
      (child.stdout as EventEmitter).emit("data", JSON.stringify(event2) + "\n");
      expect(onEvent).toHaveBeenCalledWith(event2);

      unsubscribe();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    });

    it("ignores invalid JSON lines and logs warn", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      watchDecklinkDevices(onEvent);

      (child.stdout as EventEmitter).emit("data", "invalid json\n");
      expect(onEvent).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring invalid event line")
      );
    });

    it("logs stderr output", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      watchDecklinkDevices(() => {});

      (child.stderr as EventEmitter).emit("data", "stderr warning");
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("stderr warning")
      );
    });

    it("handles multi-line buffer", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      watchDecklinkDevices(onEvent);

      const event1 = { type: "devices", devices: [1] };
      const event2 = { type: "device_removed", devices: [2] };
      (child.stdout as EventEmitter).emit(
        "data",
        JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n"
      );

      expect(onEvent).toHaveBeenCalledTimes(2);
      expect(onEvent).toHaveBeenNthCalledWith(1, event1);
      expect(onEvent).toHaveBeenNthCalledWith(2, event2);
    });

    it("skips empty lines in watch output", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      const onEvent = jest.fn();
      watchDecklinkDevices(onEvent);

      const event = { type: "devices", devices: [] };
      (child.stdout as EventEmitter).emit(
        "data",
        "\n\n" + JSON.stringify(event) + "\n  \n"
      );

      expect(onEvent).toHaveBeenCalledTimes(1);
      expect(onEvent).toHaveBeenCalledWith(event);
    });

    it("logs when watch process emits error", () => {
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      watchDecklinkDevices(() => {});

      child.emit("error", new Error("helper crashed"));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Helper failed")
      );
    });

    it("uses console when getBridgeContext throws", () => {
      mockGetBridgeContext.mockImplementation(() => {
        throw new Error("no context");
      });
      const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const child = createMockChild();
      mockSpawn.mockReturnValue(child);

      const { watchDecklinkDevices } = require("./decklink-helper.js");
      watchDecklinkDevices(() => {});

      (child.stderr as EventEmitter).emit("data", "test");
      expect(consoleWarn).toHaveBeenCalled();

      consoleWarn.mockRestore();
    });
  });
});
