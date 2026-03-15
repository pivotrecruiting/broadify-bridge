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
  },
});

const mockBrowserWindow = jest.fn(() => createMockWindow());
const mockScreen = {
  getAllDisplays: jest.fn(() => [
    { id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, internal: false },
  ]),
  getPrimaryDisplay: jest.fn(() => ({ id: 0, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })),
};

jest.mock("electron", () => ({
  app: mockApp,
  BrowserWindow: mockBrowserWindow,
  screen: mockScreen,
}));

jest.mock("pino", () => () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock("../framebus/framebus-client.js", () => ({
  loadFrameBusModule: jest.fn(() => null),
  type: {},
}));

jest.mock("../framebus/framebus-layout.js", () => ({
  getExpectedFrameBusSizeFromHeader: jest.fn(() => 1024),
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
});
