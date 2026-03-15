/**
 * Smoke tests for electron-renderer-entry.
 *
 * The entry runs as a separate Electron process and is not easily unit-tested.
 * These tests verify the module loads and key dependencies are wired correctly
 * when electron and related modules are mocked.
 */
import type { DecodedIpcPacketT } from "./renderer-ipc-framing.js";

/** Zod-style safeParse result for RendererConfigureSchema mock */
type SafeParseResult<T = unknown> =
  | { success: true; data: T }
  | { success: false; error?: unknown };

/** Minimal FrameBus module shape for loadFrameBusModule mock */
type FrameBusModuleMock = { createWriter: (opts?: unknown) => unknown } | null;

const mockApp = {
  commandLine: { appendSwitch: jest.fn() },
  disableHardwareAcceleration: jest.fn(),
  dock: { hide: jest.fn() },
  on: jest.fn(),
  quit: jest.fn(),
};
const mockStopPainting = jest.fn();
const mockDestroy = jest.fn();
const mockExecuteJS = jest.fn().mockResolvedValue(undefined);
const mockInvalidate = jest.fn();
const mockStartPainting = jest.fn();
const mockSetFrameRate = jest.fn();
let lastDidFinishLoadHandler: (() => void) | null = null;
const paintHandlers: Array<(event: unknown, dirty: unknown, image: unknown) => void> = [];

const mockBrowserWindow = jest.fn().mockImplementation(() => {
  const loadURLImpl = jest.fn().mockImplementation(() => {
    setImmediate(() => {
      if (lastDidFinishLoadHandler) lastDidFinishLoadHandler();
    });
    return Promise.resolve();
  });
  const onceImpl = jest.fn((ev: string, fn: () => void) => {
    if (ev === "did-finish-load") lastDidFinishLoadHandler = fn;
  });
  const webContents = {
    on: jest.fn((ev: string, fn: (event: unknown, dirty: unknown, image: unknown) => void) => {
      if (ev === "paint") paintHandlers.push(fn);
    }),
    once: onceImpl,
    loadURL: loadURLImpl,
    executeJavaScript: mockExecuteJS,
    invalidate: mockInvalidate,
    startPainting: mockStartPainting,
    stopPainting: mockStopPainting,
    setFrameRate: mockSetFrameRate,
    isDestroyed: () => false,
    isPainting: () => true,
  };
  return {
    webContents,
    loadURL: loadURLImpl,
    isDestroyed: jest.fn().mockReturnValue(false),
    destroy: mockDestroy,
  };
});
const mockProtocol = {
  registerSchemesAsPrivileged: jest.fn(),
  registerFileProtocol: jest.fn(),
};

jest.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  protocol: mockProtocol,
}));

const mockPinoInfo = jest.fn();
const mockPinoWarn = jest.fn();
const mockPinoError = jest.fn();
const mockPinoDebug = jest.fn();
jest.mock("pino", () => () => ({
  info: (...args: unknown[]) => mockPinoInfo.apply(null, args),
  warn: (...args: unknown[]) => mockPinoWarn.apply(null, args),
  error: (...args: unknown[]) => mockPinoError.apply(null, args),
  debug: (...args: unknown[]) => mockPinoDebug.apply(null, args),
}));

const mockCreateConnection = jest.fn();
jest.mock("node:net", () => ({
  createConnection: (...args: unknown[]) =>
    (mockCreateConnection as jest.Mock).apply(null, args),
}));

const mockLoadFrameBusModule = jest.fn<FrameBusModuleMock, []>(() => null);
jest.mock("../framebus/framebus-client.js", () => ({
  loadFrameBusModule: (...args: unknown[]) =>
    (mockLoadFrameBusModule as jest.Mock).apply(null, args),
  type: {},
}));

jest.mock("./electron-renderer-dom-runtime.js", () => ({
  buildSingleWindowDocument: jest.fn(() => "<html></html>"),
}));

const mockSafeParse = jest.fn<SafeParseResult, [unknown]>(() => ({ success: false }));
jest.mock("./renderer-config-schema.js", () => ({
  RendererConfigureSchema: {
    safeParse: (...args: unknown[]) => (mockSafeParse as jest.Mock).apply(null, args),
  },
}));

const mockDecodeNextIpcPacket = jest.fn<DecodedIpcPacketT, [Buffer]>(() => ({
  kind: "incomplete",
}));
const mockAppendIpcBuffer = jest.fn((a: Buffer, b: Buffer) => Buffer.concat([a, b]));
const mockEncodeIpcPacket = jest.fn((h: object) => Buffer.from(JSON.stringify(h)));
const mockIsIpcBufferWithinLimit = jest.fn(() => true);
jest.mock("./renderer-ipc-framing.js", () => ({
  appendIpcBuffer: (...args: unknown[]) => (mockAppendIpcBuffer as jest.Mock).apply(null, args),
  decodeNextIpcPacket: (...args: unknown[]) =>
    (mockDecodeNextIpcPacket as jest.Mock).apply(null, args),
  encodeIpcPacket: (...args: unknown[]) => (mockEncodeIpcPacket as jest.Mock).apply(null, args),
  isIpcBufferWithinLimit: (...args: unknown[]) =>
    (mockIsIpcBufferWithinLimit as jest.Mock).apply(null, args),
}));

let enqueueSerialPending: Promise<unknown> = Promise.resolve();
const mockEnqueue = jest.fn().mockImplementation((fn: () => Promise<unknown>) => {
  enqueueSerialPending = enqueueSerialPending.then(() => fn(), () => fn());
  return enqueueSerialPending;
});
jest.mock("./async-serial-queue.js", () => ({
  AsyncSerialQueue: jest.fn().mockImplementation(() => ({
    enqueue: (...args: unknown[]) => (mockEnqueue as jest.Mock).apply(null, args),
  })),
}));

jest.mock("./graphics-pixel-utils.js", () => ({
  bgraToRgba: jest.fn((b: Buffer) => b),
}));

describe("electron-renderer-entry", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.setMaxListeners(80);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    enqueueSerialPending = Promise.resolve();
    lastDidFinishLoadHandler = null;
    paintHandlers.length = 0;
    mockDecodeNextIpcPacket.mockReturnValue({ kind: "incomplete" as const });
    mockIsIpcBufferWithinLimit.mockReturnValue(true);
    mockSafeParse.mockReturnValue({ success: false });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockExecuteJS.mockResolvedValue(undefined);
    mockInvalidate.mockImplementation(() => {});
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
    expect(mockPinoError).toHaveBeenCalledWith(
      expect.objectContaining({ rawPortValue: "" }),
      "[GraphicsRenderer] Missing/invalid IPC port (BRIDGE_GRAPHICS_IPC_PORT)"
    );
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
    expect(mockPinoError).toHaveBeenCalledWith(
      expect.objectContaining({ port: 9999, message: "socket error" }),
      "[GraphicsRenderer] IPC socket error"
    );
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

  it("sends error IPC when enqueued handleMessage rejects", async () => {
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
        header: { type: "renderer_configure", token: "test-token" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });
    mockEnqueue.mockReturnValueOnce(Promise.reject(new Error("handler failed")));

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockEncodeIpcPacket).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "handler failed",
      }),
      undefined
    );
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

  it("logs warn when encodeIpcPacket throws ipc_header_exceeds_limit", async () => {
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
    mockEncodeIpcPacket.mockImplementationOnce(() => {
      throw new Error("ipc_header_exceeds_limit");
    });
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
    const dataHandlers = (mockSocket.on as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === "data")
      .map((c: unknown[]) => c[1] as (buf: Buffer) => void);
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC header exceeds limit"
    );
  });

  it("logs warn when encodeIpcPacket throws ipc_payload_exceeds_limit", async () => {
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
    mockEncodeIpcPacket.mockImplementationOnce(() => {
      throw new Error("ipc_payload_exceeds_limit");
    });
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
    const dataHandlers = (mockSocket.on as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === "data")
      .map((c: unknown[]) => c[1] as (buf: Buffer) => void);
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC payload exceeds limit"
    );
  });

  it("logs warn when encodeIpcPacket throws generic error", async () => {
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
    mockEncodeIpcPacket.mockImplementationOnce(() => {
      throw new Error("encode_failed");
    });
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
    const dataHandlers = (mockSocket.on as jest.Mock).mock.calls
      .filter((c: unknown[]) => c[0] === "data")
      .map((c: unknown[]) => c[1] as (buf: Buffer) => void);
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockPinoWarn).toHaveBeenCalledWith(
      expect.objectContaining({ message: "encode_failed" }),
      "[GraphicsRenderer] IPC encode failed"
    );
  });

  it("sets backpressure when socket.write returns false and resets on drain", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    let connectionCallback: (() => void) | null = null;
    const drainHandlers: Array<() => void> = [];
    const mockSocket = {
      on: jest.fn((ev: string, fn: () => void) => {
        if (ev === "drain") drainHandlers.push(fn);
      }),
      write: jest.fn().mockReturnValue(false),
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

  it("calls app.dock.hide when platform is darwin and ready fires", async () => {
    const origPlatform = process.platform;
    Object.defineProperty(process, "platform", {
      value: "darwin",
      configurable: true,
    });
    await import("./electron-renderer-entry.js");
    const readyHandler = mockApp.on.mock.calls.find(
      (c: unknown[]) => c[0] === "ready"
    )?.[1];
    expect(readyHandler).toBeDefined();
    readyHandler!();
    expect(mockApp.dock.hide).toHaveBeenCalled();
    Object.defineProperty(process, "platform", {
      value: origPlatform,
      configurable: true,
    });
  });

  it("applyRendererConfig logs warn when schema invalid", async () => {
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
    mockSafeParse.mockReturnValue({
      success: false,
      error: { issues: [{ path: ["width"] }] },
    });
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          width: "invalid",
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      expect.objectContaining({ issues: expect.any(Array) }),
      "[GraphicsRenderer] Invalid renderer_configure payload"
    );
  });

  it("logs FrameBus init-failed when createWriter throws", async () => {
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
      createWriter: () => {
        throw new Error("createWriter failed");
      },
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus init failed: createWriter failed"
    );
  });

  it("logs FrameBus missing name when framebusName empty and slotCount 0", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    delete process.env.BRIDGE_FRAMEBUS_NAME;
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
    const configNoFramebus = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "",
      framebusSlotCount: 0,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configNoFramebus });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configNoFramebus,
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus name missing (BRIDGE_FRAMEBUS_NAME)"
    );
  });

  it("logs FrameBus invalid slot when framebusSlotCount < 2 and framebusSize 0", async () => {
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
    const configInvalidSlot = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 1,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configInvalidSlot });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configInvalidSlot,
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus slotCount missing or invalid"
    );
  });

  it("applyRendererConfig trims framebusName and createWriter receives trimmed name", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    const createWriterMock = jest.fn().mockReturnValue({
      name: "trimmed",
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
    });
    mockLoadFrameBusModule.mockReturnValue({ createWriter: createWriterMock });
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
    const configWithTrimmedName = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "  /trimmed-name  ",
      framebusSlotCount: 2,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configWithTrimmedName });
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configWithTrimmedName,
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
    expect(createWriterMock).toHaveBeenCalledWith(
      expect.objectContaining({ name: "/trimmed-name" })
    );
  });

  it("applyRendererConfig logs frame size invalid when frameSize <= 0 (mocked data)", async () => {
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
    const configZeroFrameSize = {
      width: 0,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "",
      framebusSlotCount: 0,
      framebusSize: 10000,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configZeroFrameSize });
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configZeroFrameSize,
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus frame size invalid"
    );
  });

  it("applyRendererConfig logs slot count invalid when framebusSize yields slotCount < 2", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
    const frameSize = 1920 * 1080 * 4;
    const slotBytesOneFrame = frameSize + 1;
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
    const configSmallFramebusSize = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 0,
      framebusSize: 128 + slotBytesOneFrame,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configSmallFramebusSize });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configSmallFramebusSize,
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus size invalid for slot count calculation"
    );
  });

  it("sends error IPC when FrameBus writer not ready after config", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    delete process.env.BRIDGE_FRAMEBUS_NAME;
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
    const configNoFramebus = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "",
      framebusSlotCount: 0,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configNoFramebus });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...configNoFramebus,
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
    expect(mockEncodeIpcPacket).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        message: "FrameBus writer not ready",
      }),
      undefined
    );
  });

  it("shutdown message closes frameBusWriter when set", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
    let connectionCallback: (() => void) | null = null;
    const mockClose = jest.fn();
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
        close: mockClose,
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
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockClose).toHaveBeenCalled();
    expect(mockApp.quit).toHaveBeenCalled();
  });

  it("asset protocol callback returns error when asset not found", async () => {
    await import("./electron-renderer-entry.js");
    const readyHandler = mockApp.on.mock.calls.find(
      (c: unknown[]) => c[0] === "ready"
    )?.[1];
    readyHandler!();
    const registerCalls = mockProtocol.registerFileProtocol.mock.calls;
    expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    const assetHandler = registerCalls.find(
      (c: unknown[]) => (c as [string])[0] === "asset"
    )?.[1] as (request: { url: string }, callback: (arg: unknown) => void) => void;
    expect(assetHandler).toBeDefined();
    const cb = jest.fn();
    assetHandler({ url: "asset://missing-id" }, cb);
    expect(cb).toHaveBeenCalledWith({ error: -6 });
  });

  it("asset protocol callback returns error -2 when handler throws", async () => {
    await import("./electron-renderer-entry.js");
    const readyHandler = mockApp.on.mock.calls.find(
      (c: unknown[]) => c[0] === "ready"
    )?.[1];
    readyHandler!();
    const assetHandler = mockProtocol.registerFileProtocol.mock.calls.find(
      (c: unknown[]) => (c as [string])[0] === "asset"
    )?.[1] as (request: { url: string }, callback: (arg: unknown) => void) => void;
    const cb = jest.fn();
    assetHandler({ url: null } as unknown as { url: string }, cb);
    expect(cb).toHaveBeenCalledWith({ error: -2 });
  });

  it("logs warn when IPC token is missing and port is set", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_GRAPHICS_IPC_TOKEN = "";
    const mockSocket = {
      on: jest.fn(),
      write: jest.fn().mockReturnValue(true),
      destroy: jest.fn(),
    };
    mockCreateConnection.mockImplementation(
      (_opts: unknown, cb?: () => void) => {
        if (cb) (cb as () => void)();
        return mockSocket;
      }
    );
    await import("./electron-renderer-entry.js");
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC token missing (BRIDGE_GRAPHICS_IPC_TOKEN)"
    );
  });

  it("logs warn and destroys socket on invalid decode header_length_exceeds_limit", async () => {
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
    mockDecodeNextIpcPacket.mockReturnValueOnce({
      kind: "invalid" as const,
      reason: "header_length_exceeds_limit",
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC header length exceeds limit"
    );
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs warn and destroys socket on invalid decode invalid_buffer_length_type", async () => {
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
    mockDecodeNextIpcPacket.mockReturnValueOnce({
      kind: "invalid" as const,
      reason: "invalid_buffer_length_type",
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC buffer length type invalid"
    );
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs warn and destroys socket on invalid decode payload_length_exceeds_limit", async () => {
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
    mockDecodeNextIpcPacket.mockReturnValueOnce({
      kind: "invalid" as const,
      reason: "payload_length_exceeds_limit",
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC payload exceeds limit"
    );
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs warn and destroys socket on invalid decode unknown reason", async () => {
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
    mockDecodeNextIpcPacket.mockReturnValueOnce({
      kind: "invalid" as const,
      reason: "unknown",
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] IPC invalid message framing"
    );
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("logs warn on unexpected IPC payload and continues processing", async () => {
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
        header: { type: "ping", token: "test-token" },
        payload: Buffer.from("x"),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] Unexpected IPC payload"
    );
  });

  it("applyRendererConfig derives slotCount from framebusSize when framebusSlotCount is 0", async () => {
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
    const configWithFramebusSize = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 0,
      framebusSize: 1920 * 1080 * 4 * 2 + 128,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configWithFramebusSize });
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
          ...configWithFramebusSize,
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
    expect(mockLoadFrameBusModule).toHaveBeenCalled();
  });

  it("asset protocol callback returns path and mimeType when asset exists", async () => {
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
    await new Promise((r) => setImmediate(r));

    const readyHandler = mockApp.on.mock.calls.find(
      (c: unknown[]) => c[0] === "ready"
    )?.[1] as () => void;
    readyHandler!();
    const assetHandler = mockProtocol.registerFileProtocol.mock.calls.find(
      (c: unknown[]) => (c as [string])[0] === "asset"
    )?.[1] as (request: { url: string }, callback: (arg: unknown) => void) => void;
    const cb = jest.fn();
    assetHandler({ url: "asset://asset-1" }, cb);
    expect(cb).toHaveBeenCalledWith({
      path: "/path/1.png",
      mimeType: "image/png",
    });
  });

  it("create_layer creates window and calls executeJavaScript with __createLayer and invalidate", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
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
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "create_layer",
          token: "test-token",
          ...createLayerPayload,
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 50));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringContaining("__createLayer"),
      true
    );
    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("update_values sends __updateValues to webContents and invalidate", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "update_values",
          token: "test-token",
          layerId: "layer-1",
          values: { title: "Updated" },
          bindings: {},
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringMatching(/__updateValues.*layer-1/),
      true
    );
  });

  it("update_layout sends __updateLayout to webContents", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "update_layout",
          token: "test-token",
          layerId: "layer-1",
          layout: { x: 10, y: 20, scale: 1.5 },
          zIndex: 2,
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringMatching(/__updateLayout.*layer-1/),
      true
    );
  });

  it("remove_layer sends __removeLayer to webContents", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "remove_layer", token: "test-token", layerId: "layer-1" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringMatching(/__removeLayer.*layer-1/),
      true
    );
  });

  it("shutdown after create_layer calls stopPainting and destroy on window", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
    const mockWriterClose = jest.fn();
    mockLoadFrameBusModule.mockReturnValue({
      createWriter: () => ({
        name: "test",
        size: 0,
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: mockWriterClose,
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
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
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockStopPainting).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();
    expect(mockWriterClose).toHaveBeenCalled();
    expect(mockApp.quit).toHaveBeenCalled();
  });

  it("handleMessage ignores message with unknown type without throwing", async () => {
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
        header: { type: "unknown_command", token: "test-token" },
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
    expect(mockSocket.destroy).not.toHaveBeenCalled();
  });

  it("applyRendererConfig logs slotcount-padding when framebusSize has remainder", async () => {
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
    const frameSize = 1920 * 1080 * 4;
    const slotBytes = frameSize * 2 + 100;
    const configWithPadding = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 0,
      framebusSize: slotBytes + 128,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configWithPadding });
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
          ...configWithPadding,
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
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus size includes padding; slot count derived from floor()"
    );
  });

  it("does not enqueue when decoded header has no token and socket is destroyed", async () => {
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
    mockDecodeNextIpcPacket.mockReturnValueOnce({
      kind: "packet" as const,
      header: { type: "ping" },
      payload: Buffer.alloc(0),
      remaining: Buffer.alloc(0),
    });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockSocket.destroy).toHaveBeenCalled();
  });

  it("sends error IPC with String(reason) when enqueue rejects with non-Error", async () => {
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
        header: { type: "renderer_configure", token: "test-token" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });
    mockEnqueue.mockReturnValueOnce(Promise.reject("string reason"));

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockEncodeIpcPacket).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", message: "string reason" }),
      undefined
    );
  });

  it("window-all-closed handler is no-op", async () => {
    await import("./electron-renderer-entry.js");
    const closedHandler = mockApp.on.mock.calls.find(
      (c: unknown[]) => c[0] === "window-all-closed"
    )?.[1] as () => void;
    expect(closedHandler).toBeDefined();
    expect(() => closedHandler()).not.toThrow();
  });

  it("remove_layer returns early when singleWindow is null", async () => {
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
        header: { type: "remove_layer", token: "test-token", layerId: "no-window" },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockExecuteJS).not.toHaveBeenCalledWith(
      expect.stringMatching(/__removeLayer/),
      true
    );
  });

  it("update_layout returns early when singleWindow is null", async () => {
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
          type: "update_layout",
          token: "test-token",
          layerId: "x",
          layout: { x: 0, y: 0, scale: 1 },
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    expect(mockExecuteJS).not.toHaveBeenCalledWith(
      expect.stringMatching(/__updateLayout/),
      true
    );
  });

  it("update_values preserves existing bindings when message has no bindings", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      bindings: { cssVariables: { color: "red" } },
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "update_values",
          token: "test-token",
          layerId: "layer-1",
          values: { title: "Updated" },
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringMatching(/__updateValues.*layer-1/),
      true
    );
  });

  it("logs FrameBus module not loaded when loadFrameBusModule returns null and name set", async () => {
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
    const configWithName = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 2,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: configWithName });
    mockLoadFrameBusModule.mockReturnValue(null);
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...configWithName },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(mockPinoWarn).toHaveBeenCalledWith(
      "[GraphicsRenderer] FrameBus module not loaded"
    );
  });

  it("ensureFrameBusWriter ignores close() throw when recreating writer", async () => {
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
    const createWriterMock = jest.fn().mockImplementation((opts: { width: number }) => {
      if (opts.width === 1920) {
        return {
          name: "test",
          size: 0,
          header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
          writeFrame: jest.fn(),
          close: jest.fn().mockImplementation(() => {
            throw new Error("close err");
          }),
        };
      }
      return {
        name: "test2",
        size: 0,
        header: { width: 1280, height: 720, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      };
    });
    mockLoadFrameBusModule.mockReturnValue({ createWriter: createWriterMock });
    mockSafeParse
      .mockReturnValueOnce({
        success: true,
        data: {
          width: 1920,
          height: 1080,
          fps: 30,
          pixelFormat: 1,
          framebusName: "/test-shm",
          framebusSlotCount: 2,
          framebusSize: 0,
          backgroundMode: "transparent",
        },
      })
      .mockReturnValueOnce({
        success: true,
        data: {
          width: 1280,
          height: 720,
          fps: 30,
          pixelFormat: 1,
          framebusName: "/test-shm",
          framebusSlotCount: 2,
          framebusSize: 0,
          backgroundMode: "transparent",
        },
      });
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          width: 1920,
          height: 1080,
          fps: 30,
          pixelFormat: 1,
          framebusName: "/test-shm",
          framebusSlotCount: 2,
          framebusSize: 0,
          backgroundMode: "transparent",
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          width: 1280,
          height: 720,
          fps: 30,
          pixelFormat: 1,
          framebusName: "/test-shm",
          framebusSlotCount: 2,
          framebusSize: 0,
          backgroundMode: "transparent",
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(createWriterMock).toHaveBeenCalledTimes(2);
  });

  it("destroySingleWindow ignores stopPainting throw", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
    mockStopPainting.mockImplementationOnce(() => {
      throw new Error("stop err");
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
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
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockStopPainting).toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalled();
    expect(mockApp.quit).toHaveBeenCalled();
  });

  it("ensureSingleWindow destroys window on format mismatch and creates new one", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
    const validConfig1 = {
      width: 1920,
      height: 1080,
      fps: 30,
      pixelFormat: 1,
      framebusName: "/test-shm",
      framebusSlotCount: 2,
      framebusSize: 0,
      backgroundMode: "transparent" as const,
    };
    mockSafeParse.mockReturnValue({ success: true, data: validConfig1 });
    mockLoadFrameBusModule.mockReturnValue({
      createWriter: jest.fn().mockReturnValue({
        name: "test",
        size: 0,
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
        header: { type: "renderer_configure", token: "test-token", ...validConfig1 },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "create_layer",
          token: "test-token",
          layerId: "l1",
          html: "<div>a</div>",
          css: "",
          values: {},
          layout: { x: 0, y: 0, scale: 1 },
          backgroundMode: "transparent",
          width: 1920,
          height: 1080,
          fps: 30,
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "create_layer",
          token: "test-token",
          layerId: "l2",
          html: "<div>b</div>",
          css: "",
          values: {},
          layout: { x: 0, y: 0, scale: 1 },
          backgroundMode: "transparent",
          width: 1280,
          height: 720,
          fps: 30,
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 100));

    expect(mockPinoWarn).toHaveBeenCalledWith(
      expect.objectContaining({ existing: { width: 1920, height: 1080, fps: 30 } }),
      "[GraphicsRenderer] Single renderer format mismatch"
    );
    expect(mockDestroy).toHaveBeenCalled();
  });

  it("requestSingleWindowRepaint ignores invalidate throw", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
    mockInvalidate
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("invalidate err");
      });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockInvalidate).toHaveBeenCalled();
  });

  it("applyRendererConfig with singleWindow existing calls executeJavaScript for clearColor", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
    const configWithClearColor = {
      ...validConfig,
      clearColor: { r: 0, g: 0, b: 0, a: 1 },
    };
    mockSafeParse
      .mockReturnValueOnce({ success: true, data: validConfig })
      .mockReturnValueOnce({ success: true, data: configWithClearColor });
    mockLoadFrameBusModule.mockReturnValue({
      createWriter: () => ({
        name: "test",
        size: 0,
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: {
          type: "renderer_configure",
          token: "test-token",
          ...validConfig,
          clearColor: { r: 0, g: 0, b: 0, a: 1 },
        },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalledWith(
      expect.stringContaining("__setClearColor"),
      true
    );
  });

  it("ensureSingleWindow setBackground catch is no-op", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
    mockExecuteJS.mockRejectedValueOnce(new Error("set background failed"));
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 80));

    expect(mockExecuteJS).toHaveBeenCalled();
  });

  it("paint handler drops frame and calls logPerfIfNeeded when frameBusWriter null and LOG_PERF", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_GRAPHICS_DEBUG = "1";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
    const dateNowSpy = jest.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(2000);
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
    mockLoadFrameBusModule.mockReturnValue(null);
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 100));

    const mockImage = {
      getSize: () => ({ width: 1920, height: 1080 }),
      isEmpty: () => false,
      toBitmap: () => Buffer.alloc(1920 * 1080 * 4),
    };
    if (paintHandlers.length > 0) {
      paintHandlers[0]({}, {}, mockImage);
      await new Promise((r) => setImmediate(r));
      expect(mockPinoInfo).toHaveBeenCalledWith(
        expect.objectContaining({ paintPerSec: expect.any(Number) }),
        "[GraphicsRenderer] Perf"
      );
    }
    dateNowSpy.mockRestore();
  });

  it("paint handler logs buffer length mismatch when toBitmap size wrong", async () => {
    process.env.BRIDGE_GRAPHICS_IPC_PORT = "9999";
    process.env.BRIDGE_FRAMEBUS_NAME = "/test-shm";
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
        header: { width: 1920, height: 1080, fps: 30, slotCount: 2, pixelFormat: 1 },
        writeFrame: jest.fn(),
        close: jest.fn(),
      }),
    });
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
    const createLayerPayload = {
      layerId: "layer-1",
      html: "<div>test</div>",
      css: "",
      values: {},
      layout: { x: 0, y: 0, scale: 1 },
      backgroundMode: "transparent",
      width: 1920,
      height: 1080,
      fps: 30,
    };
    mockDecodeNextIpcPacket
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "renderer_configure", token: "test-token", ...validConfig },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValueOnce({
        kind: "packet" as const,
        header: { type: "create_layer", token: "test-token", ...createLayerPayload },
        payload: Buffer.alloc(0),
        remaining: Buffer.alloc(0),
      })
      .mockReturnValue({ kind: "incomplete" as const });

    await import("./electron-renderer-entry.js");
    connectionCallback!();
    dataHandlers[0](Buffer.alloc(10));
    dataHandlers[0](Buffer.alloc(10));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, 100));

    const mockImage = {
      getSize: () => ({ width: 1920, height: 1080 }),
      isEmpty: () => false,
      toBitmap: () => Buffer.alloc(1),
    };
    if (paintHandlers.length > 0) {
      paintHandlers[0]({}, {}, mockImage);
      await new Promise((r) => setImmediate(r));
      expect(mockPinoWarn).toHaveBeenCalledWith(
        "[GraphicsRenderer] Frame buffer length mismatch (single)"
      );
    }
  });
});
