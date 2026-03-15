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

jest.mock("../framebus/framebus-client.js", () => ({
  loadFrameBusModule: jest.fn(() => null),
  type: {},
}));

jest.mock("./electron-renderer-dom-runtime.js", () => ({
  buildSingleWindowDocument: jest.fn(() => "<html></html>"),
}));

jest.mock("./renderer-config-schema.js", () => ({
  RendererConfigureSchema: {
    safeParse: jest.fn(() => ({ success: false })),
  },
}));

jest.mock("./renderer-ipc-framing.js", () => ({
  appendIpcBuffer: jest.fn((a: Buffer, b: Buffer) => Buffer.concat([a, b])),
  decodeNextIpcPacket: jest.fn(() => ({ kind: "incomplete" as const })),
  encodeIpcPacket: jest.fn((h: object) => Buffer.from(JSON.stringify(h))),
  isIpcBufferWithinLimit: jest.fn(() => true),
}));

jest.mock("./async-serial-queue.js", () => ({
  AsyncSerialQueue: jest.fn().mockImplementation(() => ({
    enqueue: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock("./graphics-pixel-utils.js", () => ({
  bgraToRgba: jest.fn((b: Buffer) => b),
}));

describe("electron-renderer-entry", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
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
});
