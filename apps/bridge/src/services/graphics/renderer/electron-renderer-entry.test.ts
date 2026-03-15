/**
 * Smoke tests for electron-renderer-entry.
 *
 * The entry runs as a separate Electron process and is not easily unit-tested.
 * These tests verify the module loads and key dependencies are wired correctly
 * when electron and related modules are mocked.
 */
const mockApp = {
  commandLine: { appendSwitch: jest.fn() },
  disableHardwareAcceleration: jest.fn(),
  dock: { hide: jest.fn() },
  on: jest.fn(),
  quit: jest.fn(),
};
const mockBrowserWindow = jest.fn();
const mockProtocol = {
  registerSchemesAsPrivileged: jest.fn(),
  registerFileProtocol: jest.fn(),
};

jest.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  protocol: mockProtocol,
}));

jest.mock("pino", () => () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockCreateConnection = jest.fn();
jest.mock("node:net", () => ({
  createConnection: (...args: unknown[]) => mockCreateConnection(...args),
}));

const mockLoadFrameBusModule = jest.fn(() => null);
jest.mock("../framebus/framebus-client.js", () => ({
  loadFrameBusModule: (...args: unknown[]) => mockLoadFrameBusModule(...args),
  type: {},
}));

jest.mock("./electron-renderer-dom-runtime.js", () => ({
  buildSingleWindowDocument: jest.fn(() => "<html></html>"),
}));

const mockSafeParse = jest.fn(() => ({ success: false }));
jest.mock("./renderer-config-schema.js", () => ({
  RendererConfigureSchema: {
    safeParse: (...args: unknown[]) => mockSafeParse(...args),
  },
}));

const mockDecodeNextIpcPacket = jest.fn(() => ({ kind: "incomplete" as const }));
const mockAppendIpcBuffer = jest.fn((a: Buffer, b: Buffer) => Buffer.concat([a, b]));
const mockEncodeIpcPacket = jest.fn((h: object) => Buffer.from(JSON.stringify(h)));
const mockIsIpcBufferWithinLimit = jest.fn(() => true);
jest.mock("./renderer-ipc-framing.js", () => ({
  appendIpcBuffer: (...args: unknown[]) => mockAppendIpcBuffer(...args),
  decodeNextIpcPacket: (...args: unknown[]) => mockDecodeNextIpcPacket(...args),
  encodeIpcPacket: (...args: unknown[]) => mockEncodeIpcPacket(...args),
  isIpcBufferWithinLimit: (...args: unknown[]) => mockIsIpcBufferWithinLimit(...args),
}));

const mockEnqueue = jest.fn().mockImplementation((fn: () => Promise<unknown>) => {
  void Promise.resolve().then(() => fn());
  return Promise.resolve();
});
jest.mock("./async-serial-queue.js", () => ({
  AsyncSerialQueue: jest.fn().mockImplementation(() => ({
    enqueue: (...args: unknown[]) => mockEnqueue(...args),
  })),
}));

jest.mock("./graphics-pixel-utils.js", () => ({
  bgraToRgba: jest.fn((b: Buffer) => b),
}));

describe("electron-renderer-entry", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.setMaxListeners(20);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockDecodeNextIpcPacket.mockReturnValue({ kind: "incomplete" as const });
    mockIsIpcBufferWithinLimit.mockReturnValue(true);
    mockSafeParse.mockReturnValue({ success: false });
    mockLoadFrameBusModule.mockReturnValue(null);
    process.env = {
      ...originalEnv,
      BRIDGE_GRAPHICS_IPC_PORT: "0",
      BRIDGE_GRAPHICS_IPC_TOKEN: "test-token",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("loads without throwing when IPC port is unset", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "";
    await expect(
      import("./electron-renderer-entry.js")
    ).resolves.toBeDefined();
  });

  it("registers asset protocol and app handlers on load", async () => {
    await import("./electron-renderer-entry.js");

    expect(mockProtocol.registerSchemesAsPrivileged).toHaveBeenCalled();
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
      "force-device-scale-factor",
      "1"
    );
    expect(mockApp.on).toHaveBeenCalledWith("ready", expect.any(Function));
    expect(mockApp.on).toHaveBeenCalledWith("window-all-closed", expect.any(Function));
  });

  it("does not call net.createConnection when port is 0", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "0";
    await import("./electron-renderer-entry.js");

    expect(mockCreateConnection).not.toHaveBeenCalled();
  });

  it("invokes ready handler when app.on ready fires", async () => {
    await import("./electron-renderer-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    expect(readyHandler).toBeDefined();
    expect(() => readyHandler()).not.toThrow();
  });

  it("calls disableHardwareAcceleration and disable-gpu when BRIDGE_GRAPHICS_DISABLE_GPU=1", async () => {
    process.env.BRIDGE_GRAPHICS_DISABLE_GPU = "1";
    await import("./electron-renderer-entry.js");

    expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
      "disable-gpu-compositing"
    );
  });

  it("connects IPC socket when BRIDGE_GRAPHICS_IPC_PORT is set and sends hello", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const mockSocket = {
      on: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );

    await import("./electron-renderer-entry.js");

    expect(mockCreateConnection).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1", port: 9999 }),
      expect.any(Function)
    );
    expect(connectionCallback).toBeDefined();
    connectionCallback!();
    expect(mockEncodeIpcPacket).toHaveBeenCalled();
    expect(mockSocket.write).toHaveBeenCalled();
  });

  it("handles socket drain event and resets backpressure", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const drainHandlers: Array<() => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: () => void) => {
        if (ev === "drain") drainHandlers.push(fn);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    expect(drainHandlers.length).toBeGreaterThanOrEqual(1);
    expect(() => drainHandlers[0]()).not.toThrow();
  });

  it("handles socket error and close events", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const errorHandlers: Array<(err: Error) => void> = [];
    const closeHandlers: Array<() => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (err?: Error) => void) => {
        if (ev === "error") errorHandlers.push(fn as (err: Error) => void);
        if (ev === "close") closeHandlers.push(fn as () => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    expect(errorHandlers.length).toBeGreaterThanOrEqual(1);
    expect(closeHandlers.length).toBeGreaterThanOrEqual(1);
    errorHandlers[0](new Error("socket error"));
    closeHandlers[0]();
  });

  it("logs and destroys socket when IPC buffer exceeds limit", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    mockIsIpcBufferWithinLimit.mockReturnValue(false);

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.from("data"));

    expect(mockIsIpcBufferWithinLimit).toHaveBeenCalled();
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs and destroys socket when decode returns invalid", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    mockDecodeNextIpcPacket.mockReturnValue({
      kind: "invalid",
      reason: "header_length_exceeds_limit",
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs and destroys socket on IPC token mismatch", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "ping", token: "wrong-token" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("enqueues handleMessage for renderer_configure and applies config when schema valid", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    const validConfig = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 2,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: validConfig });
    mockLoadFrameBusModule.mockReturnValue({
      createWriter: () => ({
        name: "test",
        size: 0,
        header: {
          width: 1920,
          height: 1080,
          fps: 30,
          slotCount: 2,
          pixelFormat: 1,
        },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...validConfig,
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockEnqueue).toHaveBeenCalled();
    expect(mockSafeParse).toHaveBeenCalled();
  });

  it("enqueues handleMessage for set_assets", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "set_assets",
          token: "test-token",
          assets: {
            "asset-1": { filePath: "/path/1.png", mime: "image/png" },
          },
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockEnqueue).toHaveBeenCalled();
  });

  it("calls app.quit on shutdown message", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const dataHandlers: Array<(data: Buffer) => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: (data?: Buffer) => void) => {
        if (ev === "data") dataHandlers.push(fn as (data: Buffer) => void);
      }),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "shutdown", token: "test-token" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockApp.quit).toHaveBeenCalled();
  });

  it("sends error IPC on uncaughtException", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const mockSocket = {
      on: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    mockEncodeIpcPacket.mockClear();
    process.emit("uncaughtException", new Error("test uncaught"));
    expect(mockEncodeIpcPacket).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "test uncaught",
      }),
      undefined
    );
  });

  it("sends error IPC on unhandledRejection", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const mockSocket = {
      on: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) connectionCallback = cb;
        return mockSocket;
      }
    );

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    mockEncodeIpcPacket.mockClear();
    process.emit(
      "unhandledRejection",
      new Error("test rejection"),
      Promise.resolve()
    );
    expect(mockEncodeIpcPacket).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "test rejection",
      }),
      undefined
    );
  });

  it("does not connect when BRIDGE_GRAPHICS_IPC_PORT is not a valid number", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "invalid";
    await import("./electron-renderer-entry.js");
    expect(mockCreateConnection).not.toHaveBeenCalled();
  });
});
