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
  outputKey: "video_sdi" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 30 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

function createMockChild(): EventEmitter & {
  stdin: EventEmitter & { write: jest.Mock; end: jest.Mock };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
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
      setImmediate(() => {
        (child as { exitCode: number | null }).exitCode = 0;
        (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
        child.emit("exit", 0, null);
      });
    }),
  });
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
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
  });

  describe("sendFrame", () => {
    it("resolves without throwing (FrameBus no-op)", async () => {
      await expect(
        adapter.sendFrame(
          { buffer: Buffer.alloc(0), width: 1920, height: 1080 },
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
  });

  describe("getLogger", () => {
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
