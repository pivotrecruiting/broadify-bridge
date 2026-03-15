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

jest.mock("node:crypto", () => ({
  randomBytes: () => Buffer.alloc(16, 0x61),
}));

const mockSpawn = jest.fn();
jest.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

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
  const client = new ElectronRendererClient();
  mockSpawn.mockImplementation((_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
    const child = createMockChild();
    const env = opts?.env || {};
    const port = parseInt(env.BRIDGE_GRAPHICS_IPC_PORT || "0", 10);
    const token = env.BRIDGE_GRAPHICS_IPC_TOKEN || "";

    setImmediate(() => {
      clientSocket = net.connect({ port, host: "127.0.0.1" }, () => {
        clientSocket?.write(encodeIpcPacket({ type: "hello", token }));
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
    jest.clearAllMocks();
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
    it("skips renderer_configure when framebus config missing", async () => {
      const c = await initializeClientWithHandshake();
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
  });
});
