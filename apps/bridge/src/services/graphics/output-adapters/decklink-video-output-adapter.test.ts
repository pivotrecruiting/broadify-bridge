import { EventEmitter } from "node:events";
import { DecklinkVideoOutputAdapter } from "./decklink-video-output-adapter.js";

jest.mock("../../../modules/decklink/decklink-helper.js", () => ({
  resolveDecklinkHelperPath: () => "/tmp/decklink-helper",
}));

const mockAccess = jest.fn().mockResolvedValue(undefined);
jest.mock("node:fs/promises", () => ({
  access: (path: string, mode: number) => mockAccess(path, mode),
}));

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockGetBridgeContext = jest.fn();
jest.mock("../../bridge-context.js", () => ({
  getBridgeContext: () => mockGetBridgeContext(),
}));

const baseConfig = {
  version: 1,
  outputKey: "video_sdi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

function createMockChild(opts?: { autoExitOnEnd?: boolean }): EventEmitter & {
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const autoExit = opts?.autoExitOnEnd !== false;
  const child = new EventEmitter() as EventEmitter & {
    stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdin = Object.assign(new EventEmitter(), {
    write: jest.fn().mockReturnValue(true),
    end: jest.fn(function (this: typeof child) {
      if (autoExit) {
        setImmediate(() => {
          (child as { exitCode: number | null }).exitCode = 0;
          (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
          child.emit("exit", 0, null);
        });
      }
    }),
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn().mockImplementation((signal?: NodeJS.Signals) => {
    (child as { exitCode: number | null }).exitCode = 0;
    (child as { signalCode: NodeJS.Signals | null }).signalCode = signal ?? null;
    child.emit("exit", 0, signal ?? null);
  });
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

describe("DecklinkVideoOutputAdapter", () => {
  let adapter: DecklinkVideoOutputAdapter;

  beforeEach(() => {
    jest.clearAllMocks();
    mockAccess.mockResolvedValue(undefined);
    mockGetBridgeContext.mockReturnValue({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });
    mockSpawn.mockImplementation(() => createMockChild());
    adapter = new DecklinkVideoOutputAdapter();
  });

  afterEach(async () => {
    await adapter.stop();
  });

  describe("configure", () => {
    it("throws when output1Id is missing", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: {},
        })
      ).rejects.toThrow("Missing output port for DeckLink video output");
    });

    it("throws when port ID is invalid", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "invalid-port" },
        })
      ).rejects.toThrow("Invalid DeckLink port ID for video output");
    });

    it("throws when port is key-only", async () => {
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi-b" },
        })
      ).rejects.toThrow("Output port must be a video-capable port");
    });

    it("throws when helper is not executable", async () => {
      mockAccess.mockRejectedValue(new Error("Permission denied"));
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("DeckLink helper not executable");
    });

    it("throws with string message when access rejects with non-Error", async () => {
      mockAccess.mockRejectedValue("unknown error");
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("DeckLink helper not executable");
    });

    it("configures and resolves when helper emits ready", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      expect(mockSpawn).toHaveBeenCalledWith(
        "/tmp/decklink-helper",
        expect.arrayContaining([
          "--playback",
          "--device",
          "decklink-1",
          "--output-port",
          "decklink-1-sdi",
          "--width",
          "1920",
          "--height",
          "1080",
          "--fps",
          "30",
        ]),
        expect.any(Object)
      );
    });

    it("passes BRIDGE_FRAMEBUS_NAME when set", async () => {
      const originalEnv = process.env.BRIDGE_FRAMEBUS_NAME;
      process.env.BRIDGE_FRAMEBUS_NAME = "test-shm";
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-hdmi" },
      });
      expect(mockSpawn.mock.calls[0]?.[2]?.env?.BRIDGE_FRAMEBUS_NAME).toBe("test-shm");
      process.env.BRIDGE_FRAMEBUS_NAME = originalEnv;
    });

    it("passes all BRIDGE_FRAME env vars when set", async () => {
      const orig = {
        BRIDGE_FRAMEBUS_NAME: process.env.BRIDGE_FRAMEBUS_NAME,
        BRIDGE_FRAMEBUS_SIZE: process.env.BRIDGE_FRAMEBUS_SIZE,
        BRIDGE_FRAME_WIDTH: process.env.BRIDGE_FRAME_WIDTH,
        BRIDGE_FRAME_HEIGHT: process.env.BRIDGE_FRAME_HEIGHT,
        BRIDGE_FRAME_FPS: process.env.BRIDGE_FRAME_FPS,
        BRIDGE_FRAME_PIXEL_FORMAT: process.env.BRIDGE_FRAME_PIXEL_FORMAT,
      };
      process.env.BRIDGE_FRAMEBUS_NAME = "shm";
      process.env.BRIDGE_FRAMEBUS_SIZE = "4096";
      process.env.BRIDGE_FRAME_WIDTH = "1920";
      process.env.BRIDGE_FRAME_HEIGHT = "1080";
      process.env.BRIDGE_FRAME_FPS = "30";
      process.env.BRIDGE_FRAME_PIXEL_FORMAT = "argb";
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const env = mockSpawn.mock.calls[0]?.[2]?.env as Record<string, string>;
      expect(env.BRIDGE_FRAMEBUS_NAME).toBe("shm");
      expect(env.BRIDGE_FRAMEBUS_SIZE).toBe("4096");
      expect(env.BRIDGE_FRAME_WIDTH).toBe("1920");
      expect(env.BRIDGE_FRAME_HEIGHT).toBe("1080");
      expect(env.BRIDGE_FRAME_FPS).toBe("30");
      expect(env.BRIDGE_FRAME_PIXEL_FORMAT).toBe("argb");
      Object.assign(process.env, orig);
    });

    it("rejects when child emits error before ready", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          child.emit("error", new Error("spawn failed"));
        });
        return child;
      });
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("spawn failed");
    });

    it("rejects when child exits before ready", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          child.emit("exit", 1, "SIGKILL");
        });
        return child;
      });
      await expect(
        adapter.configure({
          ...baseConfig,
          targets: { output1Id: "decklink-1-sdi" },
        })
      ).rejects.toThrow("exited before ready");
    });
  });

  describe("stop", () => {
    it("resolves when never configured", async () => {
      await expect(adapter.stop()).resolves.toBeUndefined();
    });

    it("sends shutdown header and cleans up when configured", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      await adapter.stop();
      expect(mockChild?.stdin.write).toHaveBeenCalled();
      expect(mockChild?.stdin.end).toHaveBeenCalled();
    });

    it("sends SIGTERM when child does not exit on shutdown", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild({ autoExitOnEnd: false });
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      jest.useFakeTimers();
      const stopPromise = adapter.stop();
      await jest.advanceTimersByTimeAsync(4100);
      await stopPromise;
      expect(mockChild?.kill).toHaveBeenCalledWith("SIGTERM");
      jest.useRealTimers();
    });

    it("sends SIGKILL when child ignores SIGTERM", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild({ autoExitOnEnd: false });
        (child as { kill: jest.Mock }).kill = jest.fn((signal?: NodeJS.Signals) => {
          if (signal === "SIGKILL") {
            (child as { exitCode: number | null }).exitCode = 0;
            (child as { signalCode: NodeJS.Signals | null }).signalCode = "SIGKILL";
            child.emit("exit", 0, "SIGKILL");
          }
        });
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      jest.useFakeTimers();
      const stopPromise = adapter.stop();
      await jest.advanceTimersByTimeAsync(6500);
      await stopPromise;
      expect(mockChild?.kill).toHaveBeenCalledWith("SIGTERM");
      expect(mockChild?.kill).toHaveBeenCalledWith("SIGKILL");
      jest.useRealTimers();
    });
  });

  describe("sendFrame", () => {
    it("resolves without throwing (FrameBus no-op)", async () => {
      await expect(
        adapter.sendFrame(
          { rgba: Buffer.alloc(0), width: 1920, height: 1080, timestamp: 0 },
          baseConfig
        )
      ).resolves.toBeUndefined();
    });
  });

  describe("handleStdout", () => {
    it("logs metrics when received", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { debug: jest.Mock };
      (mockChild?.stdout as EventEmitter).emit("data", Buffer.from('{"type":"metrics","fps":30}\n'));
      await new Promise((r) => setImmediate(r));
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("metrics"));
    });

    it("ignores message with unknown type", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { debug: jest.Mock; warn: jest.Mock };
      (mockChild?.stdout as EventEmitter).emit("data", Buffer.from('{"type":"other"}\n'));
      await new Promise((r) => setImmediate(r));
      expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("other"));
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it("logs warn on non-JSON output", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      (mockChild?.stdout as EventEmitter).emit("data", Buffer.from("not json\n"));
      await new Promise((r) => setImmediate(r));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Non-JSON"));
    });

    it("skips empty lines", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit(
            "data",
            Buffer.from('  \n{"type":"ready"}\n')
          );
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
    });

    it("logs warn on malformed JSON", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      (mockChild?.stdout as EventEmitter).emit("data", Buffer.from("{invalid}\n"));
      await new Promise((r) => setImmediate(r));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Non-JSON"));
    });
  });

  describe("stderr", () => {
    it("logs error when stderr has content", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { error: jest.Mock };
      (mockChild?.stderr as EventEmitter).emit("data", Buffer.from("helper error\n"));
      await new Promise((r) => setImmediate(r));
      expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("helper error"));
    });

    it("does not log when stderr is empty/whitespace", async () => {
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      const logger = mockGetBridgeContext().logger as { error: jest.Mock };
      (mockChild?.stderr as EventEmitter).emit("data", Buffer.from("   \n"));
      await new Promise((r) => setImmediate(r));
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe("getLogger", () => {
    it("handles logger without debug method", async () => {
      mockGetBridgeContext.mockReturnValue({
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
      });
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      (mockChild?.stdout as EventEmitter).emit("data", Buffer.from('{"type":"metrics"}\n'));
      await new Promise((r) => setImmediate(r));
    });

    it("uses console when getBridgeContext throws", async () => {
      mockGetBridgeContext.mockImplementation(() => {
        throw new Error("no context");
      });
      mockSpawn.mockImplementation(() => {
        const child = createMockChild();
        setImmediate(() => {
          (child.stdout as EventEmitter).emit("data", Buffer.from('{"type":"ready"}\n'));
        });
        return child;
      });
      const consoleError = jest.spyOn(console, "error").mockImplementation(() => {});
      await adapter.configure({
        ...baseConfig,
        targets: { output1Id: "decklink-1-sdi" },
      });
      const mockChild = mockSpawn.mock.results[0]?.value;
      (mockChild?.stderr as EventEmitter).emit("data", Buffer.from("stderr line"));
      await new Promise((r) => setImmediate(r));
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
  });
});
