import { EventEmitter } from "node:events";
import net from "node:net";
import { encodeIpcPacket } from "./renderer-ipc-framing.js";
import { ElectronRendererClient } from "./electron-renderer-client.js";

const mockResolveElectronBinary = jest.fn();
const mockResolveRendererEntry = jest.fn();
const mockDescribeBinary = jest.fn((p: string) => `path=${p}`);

jest.mock("./electron-renderer-launch.js", () => ({
  resolveElectronBinary: () => mockResolveElectronBinary(),
  resolveRendererEntry: () => mockResolveRendererEntry(),
  describeBinary: (p: string) => mockDescribeBinary(p),
}));

const mockGetBridgeContext = jest.fn();
jest.mock("../../bridge-context.js", () => ({
  getBridgeContext: () => mockGetBridgeContext(),
}));

const MOCK_TOKEN = Buffer.alloc(16, 0x61).toString("hex");
jest.mock("node:crypto", () => ({
  randomBytes: () => Buffer.alloc(16, 0x61),
}));

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

let mockDecodeNextIpcPacketOverride: ((buf: Buffer) => unknown) | null = null;
let mockIsIpcBufferWithinLimitOverride: ((buf: Buffer) => boolean) | null = null;
let mockEncodeIpcPacketThrow = false;

jest.mock("./renderer-ipc-framing.js", () => {
  const actual = jest.requireActual("./renderer-ipc-framing.js") as {
    encodeIpcPacket: (h: object, buf?: Buffer) => Buffer;
    appendIpcBuffer: (a: Buffer, b: Buffer) => Buffer;
    decodeNextIpcPacket: (buf: Buffer) => unknown;
    isIpcBufferWithinLimit: (buf: Buffer) => boolean;
  };
  return {
    ...actual,
    decodeNextIpcPacket: (buf: Buffer) => {
      if (mockDecodeNextIpcPacketOverride) {
        const result = mockDecodeNextIpcPacketOverride(buf);
        if (result !== undefined) return result;
      }
      return actual.decodeNextIpcPacket(buf);
    },
    isIpcBufferWithinLimit: (buf: Buffer) =>
      mockIsIpcBufferWithinLimitOverride ? mockIsIpcBufferWithinLimitOverride(buf) : actual.isIpcBufferWithinLimit(buf),
    encodeIpcPacket: (h: object, buf?: Buffer) => {
      if (mockEncodeIpcPacketThrow) {
        throw new Error("encode failed");
      }
      return actual.encodeIpcPacket(h, buf);
    },
  };
});

function createMockChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: jest.Mock;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

let clientSocket: net.Socket | null = null;

async function initializeClientWithHandshake(): Promise<ElectronRendererClient> {
  return initializeClientWithCustomHello((token) =>
    encodeIpcPacket({ type: "hello", token })
  );
}

async function initializeClientWithCustomHello(
  buildHelloPacket: (token: string) => Buffer
): Promise<ElectronRendererClient> {
  const client = new ElectronRendererClient();
  mockSpawn.mockImplementation((_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
    const child = createMockChild();
    const env = opts?.env || {};
    const port = parseInt(env.BRIDGE_GRAPHICS_IPC_PORT || "0", 10);
    const token = env.BRIDGE_GRAPHICS_IPC_TOKEN || "";

    setImmediate(() => {
      clientSocket = net.connect({ port, host: "127.0.0.1" }, () => {
        clientSocket?.write(buildHelloPacket(token));
      });
    });

    return child;
  });

  mockResolveElectronBinary.mockReturnValue("/path/to/electron");
  mockResolveRendererEntry.mockReturnValue("/path/to/entry");
  await client.initialize();
  return client;
}

describe("ElectronRendererClient", () => {
  let client: ElectronRendererClient;

  beforeEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
    mockDecodeNextIpcPacketOverride = null;
    mockIsIpcBufferWithinLimitOverride = null;
    mockEncodeIpcPacketThrow = false;
    mockGetBridgeContext.mockReturnValue({
      logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    });

    mockSpawn.mockImplementation(() => createMockChild());

    client = new ElectronRendererClient();
  });

  afterEach(async () => {
    clientSocket?.destroy();
    clientSocket = null;
  });

  describe("initialize", () => {
    it("throws when Electron binary is not found", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(client.initialize()).rejects.toThrow(
        "Electron binary not found for graphics renderer"
      );
    });

    it("throws when renderer entry is not found", async () => {
      mockResolveElectronBinary.mockReturnValue("/path/to/electron");
      mockResolveRendererEntry.mockReturnValue(null);
      await expect(client.initialize()).rejects.toThrow(
        "Electron renderer entry not found"
      );
    });

    it("initializes and completes handshake when hello received", async () => {
      const c = await initializeClientWithHandshake();
      expect(c).toBeDefined();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("returns early when already initialized", async () => {
      const c = await initializeClientWithHandshake();
      await c.initialize();
      await c.initialize();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("configureSession", () => {
    it("skips renderer_configure and logs warn when framebus config missing", async () => {
      const c = await initializeClientWithHandshake();
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      await c.configureSession({
        width: 1920,
        height: 1080,
        fps: 60,
        pixelFormat: 1,
        framebusName: "",
        framebusSlotCount: 0,
        framebusSize: 0,
        backgroundMode: "transparent",
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("FrameBus config missing")
      );
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("sends renderer_configure and resolves when ready received", async () => {
      const c = await initializeClientWithHandshake();
      const config = {
        width: 1920,
        height: 1080,
        fps: 60,
        pixelFormat: 1,
        framebusName: "/test-shm",
        framebusSlotCount: 2,
        framebusSize: 4096,
        backgroundMode: "transparent" as const,
      };
      const configurePromise = c.configureSession(config);
      clientSocket?.write(encodeIpcPacket({ type: "ready", token: MOCK_TOKEN }));
      await expect(configurePromise).resolves.toBeUndefined();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("setAssets", () => {
    it("returns early when not initialized", async () => {
      await client.setAssets({ a1: { filePath: "/p1", mime: "image/png" } });
    });

    it("calls sendCommand when initialized and handshake complete", async () => {
      const c = await initializeClientWithHandshake();
      await expect(
        c.setAssets({ a1: { filePath: "/p/a1.png", mime: "image/png" } })
      ).resolves.toBeUndefined();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("renderLayer", () => {
    it("calls ensureReady which initializes when needed", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(
        client.renderLayer({
          layerId: "l1",
          html: "<div>test</div>",
          css: "",
          values: {},
          layout: { x: 0, y: 0, scale: 1 },
          backgroundMode: "transparent",
          width: 1920,
          height: 1080,
          fps: 60,
        })
      ).rejects.toThrow("Electron binary not found");
    });
  });

  describe("updateValues", () => {
    it("calls ensureReady which initializes when needed", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(client.updateValues("l1", {})).rejects.toThrow(
        "Electron binary not found"
      );
    });
  });

  describe("updateLayout", () => {
    it("calls ensureReady which initializes when needed", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(
        client.updateLayout("l1", { x: 0, y: 0, scale: 1 })
      ).rejects.toThrow("Electron binary not found");
    });

    it(
      "sends update_layout with zIndex when provided",
      async () => {
        const c = await initializeClientWithHandshake();
        const configPromise = c.configureSession({
          width: 1920,
          height: 1080,
          fps: 60,
          pixelFormat: 1,
          framebusName: "/test-shm",
          framebusSlotCount: 2,
          framebusSize: 4096,
          backgroundMode: "transparent",
        });
        clientSocket?.write(encodeIpcPacket({ type: "ready", token: MOCK_TOKEN }));
        await configPromise;
        await c.updateLayout("l1", { x: 0, y: 0, scale: 1 }, 5);
        clientSocket?.destroy();
        clientSocket = null;
        const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
        if (mockChild) {
          (mockChild as { exitCode: number | null }).exitCode = 0;
          (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
        }
        await c.shutdown();
      },
      10000
    );
  });

  describe("removeLayer", () => {
    it("calls ensureReady which initializes when needed", async () => {
      mockResolveElectronBinary.mockReturnValue(null);
      await expect(client.removeLayer("l1")).rejects.toThrow(
        "Electron binary not found"
      );
    });
  });

  describe("shutdown", () => {
    it("resolves without throwing when never initialized", async () => {
      await expect(client.shutdown()).resolves.toBeUndefined();
    });

    it("sends shutdown and cleans up when initialized", async () => {
      const c = await initializeClientWithHandshake();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("onError", () => {
    it("accepts callback without throwing", () => {
      expect(() => client.onError(() => {})).not.toThrow();
    });

    it("invokes callback on renderer exit", async () => {
      const c = await initializeClientWithHandshake();
      const onError = jest.fn();
      c.onError(onError);
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      mockChild?.emit("exit", 1, "SIGTERM");
      await new Promise((r) => setImmediate(r));
      expect(onError).toHaveBeenCalled();
      clientSocket?.destroy();
      clientSocket = null;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 1;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = "SIGTERM";
      }
      await c.shutdown();
    });

    it("invokes callback when renderer sends error message", async () => {
      const c = await initializeClientWithHandshake();
      const onError = jest.fn();
      c.onError(onError);
      clientSocket?.write(
        encodeIpcPacket({
          type: "error",
          token: MOCK_TOKEN,
          message: "FrameBus init failed",
        })
      );
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setImmediate(r));
        if (onError.mock.calls.length > 0) break;
      }
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect((onError.mock.calls[0]?.[0] as Error).message).toBe("FrameBus init failed");
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("child process", () => {
    it("rejects ready when child emits error", async () => {
      mockResolveElectronBinary.mockReturnValue("/path/to/electron");
      mockResolveRendererEntry.mockReturnValue("/path/to/entry");
      mockSpawn.mockImplementation(() => {
        const ch = createMockChild();
        setImmediate(() => ch.emit("error", new Error("spawn failed")));
        return ch;
      });
      const c = new ElectronRendererClient();
      await expect(c.initialize()).rejects.toThrow("spawn failed");
    });
  });

  describe("sendCommand", () => {
    it("logs warn when encodeIpcPacket throws", async () => {
      const c = await initializeClientWithHandshake();
      mockEncodeIpcPacketThrow = true;
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      c.updateValues("l1", { x: 1 });
      await new Promise((r) => setImmediate(r));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to encode command")
      );
      mockEncodeIpcPacketThrow = false;
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("startIpcServer", () => {
    it("rejects extra client when second socket connects", async () => {
      const c = await initializeClientWithHandshake();
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      const port = parseInt(
        (mockSpawn.mock.calls[0]?.[2] as { env?: Record<string, string> })?.env
          ?.BRIDGE_GRAPHICS_IPC_PORT || "0",
        10
      );
      const secondSocket = net.connect({ port, host: "127.0.0.1" });
      await new Promise<void>((resolve) => {
        secondSocket.on("close", () => resolve());
        secondSocket.on("error", () => resolve());
      });
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Rejecting extra client")
      );
      secondSocket.destroy();
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("handleIpcData", () => {
    it("ignores message before handshake when ready sent first", async () => {
      const c = await initializeClientWithCustomHello((token) =>
        Buffer.concat([
          encodeIpcPacket({ type: "ready", token }),
          encodeIpcPacket({ type: "hello", token }),
        ])
      );
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Ignoring message before handshake")
      );
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("logs warn on unexpected binary payload", async () => {
      const c = await initializeClientWithHandshake();
      clientSocket?.write(
        encodeIpcPacket(
          { type: "ready", token: MOCK_TOKEN, bufferLength: 3 },
          Buffer.from([1, 2, 3])
        )
      );
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      expect(
        logger.warn.mock.calls.some((call) =>
          String(call[0]).includes("Unexpected binary payload")
        )
      ).toBe(true);
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("logs warn on token mismatch for non-hello message", async () => {
      const c = await initializeClientWithHandshake();
      clientSocket?.write(
        encodeIpcPacket({ type: "ready", token: "wrongtoken12345678901234567890" })
      );
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      expect(
        logger.warn.mock.calls.some((call) =>
          String(call[0]).includes("Token mismatch on message")
        )
      ).toBe(true);
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("logs warn on unexpected frame payload", async () => {
      const c = await initializeClientWithHandshake();
      clientSocket?.write(encodeIpcPacket({ type: "frame", token: MOCK_TOKEN }));
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      expect(
        logger.warn.mock.calls.some((call) =>
          String(call[0]).includes("Unexpected frame payload")
        )
      ).toBe(true);
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("handleRendererOutput", () => {
    it("flushes stdout and logs parsed lines", async () => {
      const c = await initializeClientWithHandshake();
      const logger = mockGetBridgeContext().logger as { info: jest.Mock };
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      (mockChild?.stdout as EventEmitter)?.emit("data", Buffer.from('{"level":30,"msg":"test"}\n'));
      await new Promise((r) => setImmediate(r));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("test"));
      clientSocket?.destroy();
      clientSocket = null;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });

    it("flushes stderr and logs with fallback level", async () => {
      const c = await initializeClientWithHandshake();
      const logger = mockGetBridgeContext().logger as { warn: jest.Mock };
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      (mockChild?.stderr as EventEmitter)?.emit("data", Buffer.from("stderr warning\n"));
      await new Promise((r) => setImmediate(r));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("stderr warning"));
      clientSocket?.destroy();
      clientSocket = null;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });

  describe("getLogger", () => {
    it("uses console when getBridgeContext throws", async () => {
      const c = await initializeClientWithHandshake();
      const consoleWarn = jest.spyOn(console, "warn").mockImplementation(() => {});
      mockGetBridgeContext.mockImplementation(() => {
        throw new Error("no context");
      });
      await c.configureSession({
        width: 1920,
        height: 1080,
        fps: 60,
        pixelFormat: 1,
        framebusName: "",
        framebusSlotCount: 0,
        framebusSize: 0,
        backgroundMode: "transparent",
      });
      expect(consoleWarn).toHaveBeenCalled();
      consoleWarn.mockRestore();
      mockGetBridgeContext.mockReturnValue({
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      });
      clientSocket?.destroy();
      clientSocket = null;
      const mockChild = mockSpawn.mock.results[mockSpawn.mock.results.length - 1]?.value;
      if (mockChild) {
        (mockChild as { exitCode: number | null }).exitCode = 0;
        (mockChild as { signalCode: NodeJS.Signals | null }).signalCode = null;
      }
      await c.shutdown();
    });
  });
});
