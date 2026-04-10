/**
 * Smoke tests for display-output-entry.
 *
 * The entry runs as a separate Electron process for display output.
 * These tests verify the module loads and key setup runs when mocks are in place.
 */
const mockApp = {
  commandLine: { appendSwitch: jest.fn() },
  disableHardwareAcceleration: jest.fn(),
  exit: jest.fn(),
  on: jest.fn(),
  quit: jest.fn(),
};

const createMockWindow = () => ({
  setMenuBarVisibility: jest.fn(),
  setAlwaysOnTop: jest.fn(),
  isDestroyed: jest.fn(() => false),
  getBounds: jest.fn(() => ({ width: 1920, height: 1080 })),
  loadURL: jest.fn(),
  webContents: {
    on: jest.fn(),
    setWindowOpenHandler: jest.fn(),
    send: jest.fn(),
    executeJavaScript: jest.fn().mockResolvedValue(true),
  },
});

const mockBrowserWindow = jest.fn(() => createMockWindow());
const mockScreen = {
  getAllDisplays: jest.fn(() => [
    {
      id: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
      internal: false,
    },
  ]),
  getPrimaryDisplay: jest.fn(() => ({
    id: 0,
    bounds: { x: 0, y: 0, width: 1920, height: 1080 },
    size: { width: 1920, height: 1080 },
  })),
};

jest.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  screen: mockScreen,
}));

const mockPino = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};
jest.mock("pino", () => () => mockPino);

const mockLoadFrameBusModule = jest.fn(() => null);
jest.mock("../framebus/framebus-client.js", () => ({
  loadFrameBusModule: (...args: unknown[]) => mockLoadFrameBusModule(...args),
  type: {},
}));

const mockGetExpectedFrameBusSizeFromHeader = jest.fn(() => 1024);
jest.mock("../framebus/framebus-layout.js", () => ({
  getExpectedFrameBusSizeFromHeader: (...args: unknown[]) =>
    mockGetExpectedFrameBusSizeFromHeader(...args),
}));

describe("display-output-entry", () => {
  const originalEnv = process.env;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    process.env = {
      ...originalEnv,
      BRIDGE_DISPLAY_PRELOAD: "/path/to/preload.js",
      BRIDGE_FRAMEBUS_NAME: "",
    };
    (process.stdout.write as unknown) = jest.fn();
  });

  afterAll(() => {
    process.env = originalEnv;
    process.stdout.write = originalStdoutWrite;
  });

  it("exits when preload path is missing", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "";
    await import("./display-output-entry.js");
    expect(mockApp.exit).toHaveBeenCalledWith(1);
  });

  it("loads and registers app handlers when preload is set", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    await import("./display-output-entry.js");

    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith(
      "force-device-scale-factor",
      "1"
    );
    expect(mockApp.on).toHaveBeenCalledWith("ready", expect.any(Function));
    expect(mockApp.on).toHaveBeenCalledWith("window-all-closed", expect.any(Function));
  });

  it("creates BrowserWindow on ready", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    expect(readyHandler).toBeDefined();
    expect(() => readyHandler()).not.toThrow();
    expect(mockScreen.getAllDisplays).toHaveBeenCalled();
    expect(mockBrowserWindow).toHaveBeenCalled();
    const win = mockBrowserWindow.mock.results[0]?.value;
    expect(win?.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(win?.setAlwaysOnTop).toHaveBeenCalledWith(true, "screen-saver");
  });

  it("selects display by name when BRIDGE_DISPLAY_MATCH_NAME is set", async () => {
    mockScreen.getAllDisplays.mockReturnValue([
      {
        id: 1,
        label: "HDMI-1",
        bounds: { x: 1920, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        internal: false,
      },
      {
        id: 2,
        name: "Built-in",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        internal: true,
      },
    ]);
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_MATCH_NAME = "hdmi";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    expect(mockBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        x: 1920,
        y: 0,
        width: 1920,
        height: 1080,
      })
    );
  });

  it("selects display by resolution when BRIDGE_DISPLAY_MATCH_WIDTH/HEIGHT are set", async () => {
    mockScreen.getAllDisplays.mockReturnValue([
      {
        id: 1,
        bounds: { x: 0, y: 0, width: 3840, height: 2160 },
        size: { width: 3840, height: 2160 },
        internal: false,
      },
      {
        id: 2,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        internal: false,
      },
    ]);
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_MATCH_WIDTH = "3840";
    process.env.BRIDGE_DISPLAY_MATCH_HEIGHT = "2160";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    expect(mockBrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 3840,
        height: 2160,
      })
    );
  });

  it("falls back to primary display when all displays are internal", async () => {
    mockScreen.getAllDisplays.mockReturnValue([
      {
        id: 0,
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        internal: true,
      },
    ]);
    mockScreen.getPrimaryDisplay.mockReturnValue({
      id: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    expect(mockScreen.getPrimaryDisplay).toHaveBeenCalled();
    expect(mockBrowserWindow).toHaveBeenCalled();
  });

  it("calls disableHardwareAcceleration when BRIDGE_DISPLAY_DISABLE_GPU is set", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_DISABLE_GPU = "1";
    await import("./display-output-entry.js");

    expect(mockApp.disableHardwareAcceleration).toHaveBeenCalled();
    expect(mockApp.commandLine.appendSwitch).toHaveBeenCalledWith("disable-gpu");
  });

  it("sends ready and starts FrameBus reader when configured", async () => {
    jest.useFakeTimers();
    const mockReadLatest = jest.fn().mockReturnValue({
      buffer: Buffer.alloc(1920 * 1080 * 4),
      timestampNs: BigInt(Date.now()) * 1_000_000n,
      seq: 1n,
    });
    const mockClose = jest.fn();
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: mockReadLatest,
        close: mockClose,
      }),
    });

    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();

    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    expect(didFinishLoadHandler).toBeDefined();
    didFinishLoadHandler();

    expect(mockLoadFrameBusModule).toHaveBeenCalled();
    const stdoutWrite = process.stdout.write as jest.Mock;
    expect(stdoutWrite).toHaveBeenCalledWith('{"type":"ready"}\n');

    jest.advanceTimersByTime(50);
    expect(win?.webContents.send).toHaveBeenCalledWith(
      "display-frame",
      expect.objectContaining({
        width: 1920,
        height: 1080,
        buffer: expect.any(Buffer),
      })
    );

    const windowAllClosedHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "window-all-closed"
    )?.[1];
    windowAllClosedHandler();
    expect(mockClose).toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("quits when FrameBus fails to open after retries", async () => {
    jest.useFakeTimers();
    mockLoadFrameBusModule.mockReturnValue(null);
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();

    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    await jest.advanceTimersByTimeAsync(2500);
    expect(mockApp.quit).toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("stops FrameBus reader on window-all-closed", async () => {
    const mockClose = jest.fn();
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: mockClose,
      }),
    });

    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();

    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    const windowAllClosedHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "window-all-closed"
    )?.[1];
    windowAllClosedHandler();

    expect(mockClose).toHaveBeenCalled();
  });

  it("fails FrameBus when width mismatch", async () => {
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1280,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1280 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_FRAME_WIDTH = "1920";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus width mismatch")
    );
  });

  it("fails FrameBus when loadFrameBusModule throws", async () => {
    mockLoadFrameBusModule.mockImplementation(() => {
      throw new Error("native addon not found");
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus open failed")
    );
  });

  it("checks preload API when BRIDGE_DISPLAY_DEBUG is enabled", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_DEBUG = "1";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });

    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();

    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.info).toHaveBeenCalledWith(
      "[DisplayOutput] Debug overlay enabled"
    );
    expect(win?.webContents.executeJavaScript).toHaveBeenCalledWith(
      "Boolean(window.displayOutput && window.displayOutput.onFrame)"
    );
  });

  it("returns primary display when match name matches no display", async () => {
    mockScreen.getAllDisplays.mockReturnValue([
      {
        id: 0,
        label: "Built-in",
        bounds: { x: 0, y: 0, width: 1920, height: 1080 },
        size: { width: 1920, height: 1080 },
        internal: true,
      },
    ]);
    mockScreen.getPrimaryDisplay.mockReturnValue({
      id: 0,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      size: { width: 1920, height: 1080 },
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_MATCH_NAME = "hdmi-nonexistent";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();

    expect(mockScreen.getPrimaryDisplay).toHaveBeenCalled();
    expect(mockBrowserWindow).toHaveBeenCalled();
  });

  it("buffers frame when window is destroyed and sends on next did-finish-load", async () => {
    jest.useFakeTimers();
    let callCount = 0;
    const mockReadLatest = jest.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return {
          buffer: Buffer.alloc(1920 * 1080 * 4),
          timestampNs: BigInt(Date.now()) * 1_000_000n,
          seq: 1n,
        };
      }
      return null;
    });
    const mockWin = createMockWindow();
    mockWin.isDestroyed.mockReturnValue(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockBrowserWindow.mockReturnValue(mockWin);
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: mockReadLatest,
        close: jest.fn(),
      }),
    });

    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const didFinishLoadHandler = mockWin.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    jest.advanceTimersByTime(50);
    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      "display-frame",
      expect.any(Object)
    );
    mockWin.webContents.send.mockClear();
    jest.advanceTimersByTime(50);
    expect(mockWin.webContents.send).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("logs perf when BRIDGE_LOG_PERF is set and interval elapsed", async () => {
    jest.useFakeTimers();
    const mockReadLatest = jest.fn().mockReturnValue({
      buffer: Buffer.alloc(1920 * 1080 * 4),
      timestampNs: BigInt(Date.now()) * 1_000_000n,
      seq: 1n,
    });
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: mockReadLatest,
        close: jest.fn(),
      }),
    });

    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_LOG_PERF = "1";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    jest.advanceTimersByTime(1100);
    expect(mockPino.info).toHaveBeenCalledWith(
      expect.objectContaining({ fps: expect.any(Number), drops: expect.any(Number) }),
      "[DisplayOutput] Perf"
    );

    jest.useRealTimers();
  });

  it("fails FrameBus when height mismatch", async () => {
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 720,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 720 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_FRAME_HEIGHT = "1080";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus height mismatch")
    );
  });

  it("fails FrameBus when fps mismatch", async () => {
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 30,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_FRAME_FPS = "50";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus fps mismatch")
    );
  });

  it("fails FrameBus when pixelFormat is not RGBA8", async () => {
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 2,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus pixel format mismatch")
    );
  });

  it("fails FrameBus when frameBusPixelFormat env does not match header", async () => {
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_FRAME_PIXEL_FORMAT = "2";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus pixel format mismatch")
    );
  });

  it("fails FrameBus when size mismatch", async () => {
    mockGetExpectedFrameBusSizeFromHeader.mockReturnValue(2048);
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_FRAMEBUS_SIZE = "1024";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    expect(mockPino.error).toHaveBeenCalledWith(
      expect.stringContaining("FrameBus size mismatch")
    );
  });

  it("interval skips when readLatest returns null", async () => {
    jest.useFakeTimers();
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    jest.advanceTimersByTime(50);
    expect(win?.webContents.send).not.toHaveBeenCalled();

    jest.useRealTimers();
  });

  it("counts repeat frames when readLatest returns same seq", async () => {
    jest.useFakeTimers();
    const mockReadLatest = jest
      .fn()
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 1n,
      })
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 1n,
      })
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 2n,
      })
      .mockReturnValue(null);
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: mockReadLatest,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_LOG_PERF = "1";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    jest.advanceTimersByTime(1000);
    didFinishLoadHandler();
    jest.advanceTimersByTime(25);
    jest.advanceTimersByTime(25);
    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(25);
    expect(mockPino.info).toHaveBeenCalledWith(
      expect.objectContaining({ repeats: expect.any(Number) }),
      "[DisplayOutput] Perf"
    );

    jest.useRealTimers();
  });

  it("counts dropped frames when seq has gap", async () => {
    jest.useFakeTimers();
    const mockReadLatest = jest
      .fn()
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 1n,
      })
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 5n,
      })
      .mockReturnValueOnce({
        buffer: Buffer.alloc(1920 * 1080 * 4),
        timestampNs: BigInt(Date.now()) * 1_000_000n,
        seq: 6n,
      })
      .mockReturnValue(null);
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: mockReadLatest,
        close: jest.fn(),
      }),
    });
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    process.env.BRIDGE_LOG_PERF = "1";
    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const win = mockBrowserWindow.mock.results[0]?.value;
    const didFinishLoadHandler = win?.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    jest.advanceTimersByTime(1000);
    didFinishLoadHandler();
    jest.advanceTimersByTime(25);
    jest.advanceTimersByTime(25);
    jest.advanceTimersByTime(1000);
    jest.advanceTimersByTime(25);
    expect(mockPino.info).toHaveBeenCalledWith(
      expect.objectContaining({ drops: expect.any(Number) }),
      "[DisplayOutput] Perf"
    );

    jest.useRealTimers();
  });

  it("logs preload API check failure when executeJavaScript rejects", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_DEBUG = "1";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    const mockWin = createMockWindow();
    mockWin.webContents.executeJavaScript.mockRejectedValue(
      new Error("script failed")
    );
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    mockBrowserWindow.mockReturnValue(mockWin);

    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const didFinishLoadHandler = mockWin.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPino.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: "script failed" }),
      "[DisplayOutput] Failed to check preload API"
    );
  });

  it("logs preload API availability when executeJavaScript resolves", async () => {
    process.env.BRIDGE_DISPLAY_PRELOAD = "/path/to/preload.js";
    process.env.BRIDGE_DISPLAY_DEBUG = "1";
    process.env.BRIDGE_FRAMEBUS_NAME = "test-framebus";
    const mockWin = createMockWindow();
    mockWin.webContents.executeJavaScript.mockResolvedValue(true);
    mockLoadFrameBusModule.mockReturnValue({
      openReader: () => ({
        name: "test",
        header: {
          width: 1920,
          height: 1080,
          fps: 50,
          pixelFormat: 1,
          headerSize: 128,
          slotCount: 1,
          slotStride: 1920 * 1080 * 4,
        },
        readLatest: () => null,
        close: jest.fn(),
      }),
    });
    mockBrowserWindow.mockReturnValue(mockWin);

    await import("./display-output-entry.js");

    const readyHandler = mockApp.on.mock.calls.find(
      (call: unknown[]) => call[0] === "ready"
    )?.[1];
    readyHandler();
    const didFinishLoadHandler = mockWin.webContents.on.mock.calls.find(
      (call: unknown[]) => call[0] === "did-finish-load"
    )?.[1];
    didFinishLoadHandler();

    await Promise.resolve();
    await Promise.resolve();
    expect(mockPino.info).toHaveBeenCalledWith(
      expect.objectContaining({ hasApi: true }),
      "[DisplayOutput] Preload API availability"
    );
  });
});
