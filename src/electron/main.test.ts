/**
 * Tests for main process (main.ts).
 * Uses dynamic import and mocked argv so that the main app path runs.
 */

const readyHandlers: Array<() => void> = [];
const secondInstanceHandlers: Array<() => void> = [];
const openUrlHandlers: Array<(event: { preventDefault: () => void }, _url: string) => void> = [];
const beforeQuitHandlers: Array<() => void | Promise<void>> = [];

const mockIpcMainHandle = jest.fn();
const mockIpcWebContentsSend = jest.fn();
const mockIsDev = jest.fn().mockReturnValue(false);

jest.mock("./util.js", () => ({
  ipcMainHandle: (...args: unknown[]) => mockIpcMainHandle(...args),
  isDev: () => mockIsDev(),
  ipcWebContentsSend: (...args: unknown[]) => mockIpcWebContentsSend(...args),
}));

jest.mock("./pathResolver.js", () => ({
  getPreloadPath: () => "/preload",
  getUIPath: () => "/ui/index.html",
  getIconPath: () => "/icon.png",
}));

jest.mock("./test.js", () => ({
  getStaticData: () => ({ platform: "darwin", arch: "x64" }),
  pollResources: jest.fn(),
}));

const mockStart = jest.fn().mockResolvedValue({ success: true });
const mockStop = jest.fn().mockResolvedValue(undefined);
const mockGetConfig = jest.fn().mockReturnValue({ host: "127.0.0.1", port: 8787 });
const mockIsRunning = jest.fn().mockReturnValue(true);

jest.mock("./services/bridge-process-manager.js", () => ({
  bridgeProcessManager: {
    start: (...args: unknown[]) => mockStart(...args),
    stop: () => mockStop(),
    getConfig: () => mockGetConfig(),
    isRunning: () => mockIsRunning(),
  },
}));

const mockStartHealthCheckPolling = jest.fn().mockReturnValue(() => {});
const mockCheckBridgeHealth = jest.fn().mockResolvedValue({ reachable: true });
jest.mock("./services/bridge-health-check.js", () => ({
  startHealthCheckPolling: (...args: unknown[]) =>
    mockStartHealthCheckPolling(...args),
  checkBridgeHealth: (...args: unknown[]) => mockCheckBridgeHealth(...args),
}));

const mockFetchBridgeOutputs = jest.fn().mockResolvedValue({
  output1: [],
  output2: [],
});
jest.mock("./services/bridge-outputs.js", () => ({
  fetchBridgeOutputs: (...args: unknown[]) => mockFetchBridgeOutputs(...args),
}));

const mockClearBridgeLogs = jest.fn().mockResolvedValue({ error: null });
const mockFetchBridgeLogs = jest.fn().mockResolvedValue({ lines: [], error: null });
jest.mock("./services/bridge-logs.js", () => ({
  clearBridgeLogs: (...args: unknown[]) => mockClearBridgeLogs(...args),
  fetchBridgeLogs: (...args: unknown[]) => mockFetchBridgeLogs(...args),
}));

jest.mock("./services/bridge-identity.js", () => ({
  bridgeIdentity: { getBridgeId: () => "test-bridge-id" },
}));

const mockGetProfile = jest.fn().mockReturnValue({
  bridgeId: "test-bridge-id",
  bridgeName: "TestBridge",
  termsAcceptedAt: "2020-01-01T00:00:00Z",
});
const mockSetTermsAccepted = jest.fn();
const mockSetBridgeName = jest.fn();

jest.mock("./services/bridge-profile.js", () => ({
  bridgeProfile: {
    getProfile: () => mockGetProfile(),
    setTermsAccepted: () => mockSetTermsAccepted(),
    setBridgeName: (name: string) => mockSetBridgeName(name),
  },
}));

const mockStartPairing = jest.fn().mockReturnValue({
  code: "123456",
  expiresAt: Date.now() + 60000,
});
const mockGetPairingInfo = jest.fn().mockReturnValue(null);
const mockClearPairing = jest.fn();

jest.mock("./services/bridge-pairing.js", () => ({
  bridgePairing: {
    startPairing: () => mockStartPairing(),
    getPairingInfo: () => mockGetPairingInfo(),
    clear: () => mockClearPairing(),
  },
}));

const mockBridgeApiRequest = jest.fn().mockResolvedValue({ state: {} });
jest.mock("./services/bridge-api-request.js", () => ({
  createBridgeApiRequest: () => mockBridgeApiRequest,
}));

const mockClearAppLogs = jest.fn().mockResolvedValue({ error: null });
const mockReadAppLogs = jest.fn().mockResolvedValue({ lines: [], error: null });
jest.mock("./services/app-logs.js", () => ({
  clearAppLogs: (...args: unknown[]) => mockClearAppLogs(...args),
  readAppLogs: (...args: unknown[]) => mockReadAppLogs(...args),
}));

const mockLogAppError = jest.fn();
jest.mock("./services/app-logger.js", () => ({
  logAppError: (...args: unknown[]) => mockLogAppError(...args),
}));

const mockUpdaterInitialize = jest.fn();
const mockUpdaterGetStatus = jest.fn().mockResolvedValue({});
const mockUpdaterCheckForUpdates = jest.fn().mockResolvedValue({});
const mockUpdaterDownloadUpdate = jest.fn().mockResolvedValue({});
const mockUpdaterQuitAndInstall = jest.fn();
const mockUpdaterShutdown = jest.fn();

jest.mock("./services/app-updater.js", () => ({
  appUpdaterService: {
    initialize: (cb: (status: unknown) => void) => mockUpdaterInitialize(cb),
    getStatus: () => mockUpdaterGetStatus(),
    checkForUpdates: () => mockUpdaterCheckForUpdates(),
    downloadUpdate: () => mockUpdaterDownloadUpdate(),
    quitAndInstall: () => mockUpdaterQuitAndInstall(),
    shutdown: () => mockUpdaterShutdown(),
  },
}));

jest.mock("./services/port-checker.js", () => ({
  isPortAvailable: jest.fn().mockResolvedValue(true),
  checkPortsAvailability: jest.fn().mockResolvedValue(new Map([[8787, true]])),
}));

const mockValidateEngineConnectInput = jest.fn().mockReturnValue({
  success: true,
  body: { ip: "127.0.0.1", port: 8080 },
});
jest.mock("./services/engine-connect-contract.js", () => ({
  validateEngineConnectInput: (...args: unknown[]) =>
    mockValidateEngineConnectInput(...args),
}));

const mockIsAllowedExternalUrl = jest.fn().mockReturnValue(true);
jest.mock("./services/external-url.js", () => ({
  isAllowedExternalUrl: (...args: unknown[]) => mockIsAllowedExternalUrl(...args),
}));

const mockDetectNetworkInterfaces = jest.fn().mockReturnValue([
  { id: "localhost", bindAddress: "127.0.0.1", interface: "loopback" },
]);
const mockResolveBindAddress = jest.fn().mockReturnValue("127.0.0.1");

jest.mock("./services/network-interface-detector.js", () => ({
  detectNetworkInterfaces: (...args: unknown[]) =>
    mockDetectNetworkInterfaces(...args),
  resolveBindAddress: (...args: unknown[]) => mockResolveBindAddress(...args),
}));

const mockExistsSync = jest.fn().mockReturnValue(false);
const mockReadFileSync = jest.fn();
const mockWriteFileSync = jest.fn();

jest.mock("fs", () => ({
  existsSync: (p: string) => mockExistsSync(p),
  readFileSync: (p: string, ...args: unknown[]) => mockReadFileSync(p, ...args),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
}));

jest.mock("@sentry/electron", () => ({
  init: jest.fn(),
}));

const mockAppExit = jest.fn();
const mockAppQuit = jest.fn();
let singleInstanceLockReturns = true;
const mockRequestSingleInstanceLock = jest.fn(() => singleInstanceLockReturns);
const mockAppOn = jest.fn((event: string, handler: () => void) => {
  if (event === "ready") readyHandlers.push(handler);
  if (event === "second-instance") secondInstanceHandlers.push(handler);
  if (event === "open-url")
    openUrlHandlers.push(handler as (event: { preventDefault: () => void }, _url: string) => void);
  if (event === "before-quit") beforeQuitHandlers.push(handler);
});

jest.mock("electron", () => ({
  app: {
    getPath: jest.fn().mockReturnValue("/tmp/userData"),
    getAppPath: jest.fn().mockReturnValue("/app"),
    getVersion: jest.fn().mockReturnValue("1.0.0"),
    get requestSingleInstanceLock() {
      return mockRequestSingleInstanceLock;
    },
    exit: (code?: number) => mockAppExit(code),
    quit: () => mockAppQuit(),
    on: mockAppOn,
  },
  BrowserWindow: jest.fn().mockImplementation(function (
    this: {
      webContents: { send: jest.Mock };
      loadURL: jest.Mock;
      loadFile: jest.Mock;
      on: jest.Mock;
      isDestroyed: jest.Mock;
      isMinimized: jest.Mock;
      restore: jest.Mock;
      focus: jest.Mock;
    },
  ) {
    this.webContents = { send: jest.fn() };
    this.loadURL = jest.fn();
    this.loadFile = jest.fn();
    this.on = jest.fn();
    this.isDestroyed = jest.fn().mockReturnValue(false);
    this.isMinimized = jest.fn().mockReturnValue(false);
    this.restore = jest.fn();
    this.focus = jest.fn();
    return this;
  }),
  shell: { openExternal: jest.fn() },
}));

describe("main", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    jest.clearAllMocks();
    readyHandlers.length = 0;
    secondInstanceHandlers.length = 0;
    openUrlHandlers.length = 0;
    beforeQuitHandlers.length = 0;
    process.argv = ["/usr/bin/electron", "/app"];
    mockExistsSync.mockReturnValue(false);
    mockIsDev.mockReturnValue(false);
    mockGetProfile.mockReturnValue({
      bridgeId: "test-bridge-id",
      bridgeName: "TestBridge",
      termsAcceptedAt: "2020-01-01T00:00:00Z",
    });
    mockStart.mockResolvedValue({ success: true });
    mockGetConfig.mockReturnValue({ host: "127.0.0.1", port: 8787 });
    mockIsRunning.mockReturnValue(true);
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  describe("main app path (no graphics-renderer)", () => {
    beforeEach(async () => {
      jest.resetModules();
      await import("./main.js");
    });

    it("registers ready handler and creates window when ready is emitted", async () => {
      expect(readyHandlers.length).toBe(1);
      await readyHandlers[0]();
      const { BrowserWindow } = await import("electron");
      expect(BrowserWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          webPreferences: expect.objectContaining({ preload: "/preload" }),
          width: 800,
          height: 700,
        }),
      );
    });

    it("registers IPC handlers on ready", async () => {
      await readyHandlers[0]();
      const channels = mockIpcMainHandle.mock.calls.map((c: unknown[]) => c[0]);
      expect(channels).toContain("getStaticData");
      expect(channels).toContain("bridgeGetProfile");
      expect(channels).toContain("bridgeAcceptTerms");
      expect(channels).toContain("bridgeSetName");
      expect(channels).toContain("bridgeStart");
      expect(channels).toContain("bridgeStop");
      expect(channels).toContain("bridgeGetStatus");
      expect(channels).toContain("checkPortAvailability");
      expect(channels).toContain("checkPortsAvailability");
      expect(channels).toContain("getNetworkConfig");
      expect(channels).toContain("detectNetworkInterfaces");
      expect(channels).toContain("getNetworkBindingOptions");
      expect(channels).toContain("engineConnect");
      expect(channels).toContain("engineDisconnect");
      expect(channels).toContain("engineGetStatus");
      expect(channels).toContain("engineGetMacros");
      expect(channels).toContain("engineRunMacro");
      expect(channels).toContain("engineStopMacro");
      expect(channels).toContain("bridgeGetOutputs");
      expect(channels).toContain("bridgeGetLogs");
      expect(channels).toContain("appGetLogs");
      expect(channels).toContain("appGetVersion");
      expect(channels).toContain("updaterGetStatus");
      expect(channels).toContain("updaterCheckForUpdates");
      expect(channels).toContain("updaterDownloadUpdate");
      expect(channels).toContain("updaterQuitAndInstall");
      expect(channels).toContain("bridgeClearLogs");
      expect(channels).toContain("appClearLogs");
      expect(channels).toContain("openExternal");
    });

    it("second-instance focuses window", async () => {
      await readyHandlers[0]();
      expect(secondInstanceHandlers.length).toBe(1);
      const { BrowserWindow } = await import("electron");
      const win = (BrowserWindow as jest.Mock).mock.results[0].value;
      win.isMinimized.mockReturnValue(true);
      secondInstanceHandlers[0]();
      expect(win.isMinimized).toHaveBeenCalled();
      expect(win.restore).toHaveBeenCalled();
      expect(win.focus).toHaveBeenCalled();
    });

    it("open-url prevents default and focuses window", async () => {
      await readyHandlers[0]();
      expect(openUrlHandlers.length).toBe(1);
      const event = { preventDefault: jest.fn() };
      openUrlHandlers[0](event, "broadify://test");
      expect(event.preventDefault).toHaveBeenCalled();
    });

    it("before-quit runs cleanup and updater shutdown", async () => {
      await readyHandlers[0]();
      expect(beforeQuitHandlers.length).toBe(1);
      await beforeQuitHandlers[0]();
      expect(mockUpdaterShutdown).toHaveBeenCalled();
      expect(mockStop).toHaveBeenCalled();
    });

    it("bridgeGetProfile returns profile from bridgeProfile", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetProfile",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = handler();
      expect(result).toEqual({
        bridgeId: "test-bridge-id",
        bridgeName: "TestBridge",
        termsAcceptedAt: "2020-01-01T00:00:00Z",
      });
    });

    it("bridgeAcceptTerms calls setTermsAccepted and returns success", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeAcceptTerms",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = handler();
      expect(mockSetTermsAccepted).toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("bridgeSetName returns error when terms not accepted", async () => {
      mockGetProfile.mockReturnValueOnce({
        bridgeId: "id",
        bridgeName: null,
        termsAcceptedAt: null,
      });
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeSetName",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, "MyBridge");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Terms and conditions");
    });

    it("bridgeSetName returns error for invalid name length", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeSetName",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      expect(await handler(undefined, "")).toEqual({
        success: false,
        error: "Bridge name must be between 1 and 64 characters.",
      });
      expect(await handler(undefined, "a".repeat(65))).toEqual({
        success: false,
        error: "Bridge name must be between 1 and 64 characters.",
      });
    });

    it("bridgeSetName succeeds with valid name", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeSetName",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, "ValidName");
      expect(result).toEqual({ success: true });
      expect(mockSetBridgeName).toHaveBeenCalledWith("ValidName");
    });

    it("bridgeStart returns error when terms not accepted", async () => {
      mockGetProfile.mockReturnValueOnce({
        bridgeId: "id",
        bridgeName: "B",
        termsAcceptedAt: null,
      });
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Terms and conditions");
    });

    it("bridgeStart returns error when bridge name missing", async () => {
      mockGetProfile.mockReturnValueOnce({
        bridgeId: "id",
        bridgeName: null,
        termsAcceptedAt: "2020-01-01T00:00:00Z",
      });
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Bridge name is required");
    });

    it("bridgeStart calls process manager and returns result", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(result.success).toBe(true);
      expect(mockStart).toHaveBeenCalled();
    });

    it("bridgeStart success invokes health check callback with status", async () => {
      mockGetPairingInfo.mockReturnValueOnce({
        code: "999888",
        expiresAt: Date.now() + 30000,
        expired: false,
      });
      await readyHandlers[0]();
      const startIdx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const startHandler = mockIpcMainHandle.mock.calls[startIdx][1];
      await startHandler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(mockStartHealthCheckPolling).toHaveBeenCalled();
      const statusCb = mockStartHealthCheckPolling.mock.calls[0][1];
      expect(typeof statusCb).toBe("function");
      const status = { reachable: true, bridgeName: "Test" };
      statusCb(status);
      expect(mockIpcWebContentsSend).toHaveBeenCalledWith(
        "bridgeStatus",
        expect.anything(),
        expect.objectContaining({
          pairingCode: "999888",
          bridgeName: "Test",
        }),
      );
    });

    it("bridgeStart success stops previous health check when starting again", async () => {
      const cleanupFn = jest.fn();
      mockStartHealthCheckPolling.mockReturnValueOnce(cleanupFn);
      await readyHandlers[0]();
      const startIdx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const startHandler = mockIpcMainHandle.mock.calls[startIdx][1];
      await startHandler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(cleanupFn).not.toHaveBeenCalled();
      mockStartHealthCheckPolling.mockReturnValueOnce(jest.fn());
      await startHandler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(cleanupFn).toHaveBeenCalled();
    });

    it("bridgeStop stops health check and process manager", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStop",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      await handler();
      expect(mockStop).toHaveBeenCalled();
      expect(mockClearPairing).toHaveBeenCalled();
    });

    it("bridgeGetStatus returns running false when process not running", async () => {
      mockIsRunning.mockReturnValue(false);
      mockGetConfig.mockReturnValue(null);
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetStatus",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result).toEqual({ running: false, reachable: false });
    });

    it("getNetworkConfig returns config from loadNetworkConfig", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "getNetworkConfig",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result).toHaveProperty("networkBinding");
      expect(result).toHaveProperty("port");
    });

    it("checkPortAvailability returns port and available", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "checkPortAvailability",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, 8787);
      expect(result).toEqual({ port: 8787, available: true });
    });

    it("checkPortsAvailability returns array of results", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "checkPortsAvailability",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, [8787, 8788]);
      expect(Array.isArray(result)).toBe(true);
    });

    it("openExternal calls shell.openExternal when URL allowed", async () => {
      const { shell } = await import("electron");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "openExternal",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      await handler(undefined, "https://app.broadify.de");
      expect(shell.openExternal).toHaveBeenCalledWith("https://app.broadify.de");
    });

    it("appGetVersion returns app version", async () => {
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "appGetVersion",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result).toBe("1.0.0");
    });

    it("bridgeSetName returns error when setBridgeName throws", async () => {
      mockSetBridgeName.mockImplementationOnce(() => {
        throw new Error("storage error");
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeSetName",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, "ValidName");
      expect(result.success).toBe(false);
      expect(result.error).toBe("storage error");
    });

    it("bridgeStart clears pairing when start fails", async () => {
      mockStart.mockResolvedValueOnce({ success: false, error: "start failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStart",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      await handler(undefined, {
        networkBindingId: "localhost",
        host: "127.0.0.1",
        port: 8787,
      });
      expect(mockClearPairing).toHaveBeenCalled();
    });

    it("bridgeStop calls clearBridgeLogs when config exists and logs error on failure", async () => {
      mockClearBridgeLogs.mockResolvedValueOnce({ error: "clear failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeStop",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      await handler();
      expect(mockClearBridgeLogs).toHaveBeenCalled();
      expect(mockLogAppError).toHaveBeenCalledWith(
        expect.stringContaining("bridgeClearLogs on stop failed"),
      );
    });

    it("bridgeGetStatus includes pairingInfo and webAppUrl when running", async () => {
      mockGetPairingInfo.mockReturnValueOnce({
        code: "111222",
        expiresAt: Date.now() + 60000,
        expired: false,
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetStatus",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.running).toBe(true);
      expect(result.pairingCode).toBe("111222");
      expect(result.pairingExpiresAt).toBeDefined();
    });

    it("engineConnect returns validation result when validation fails", async () => {
      mockValidateEngineConnectInput.mockReturnValueOnce({
        success: false,
        error: "Invalid IP",
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineConnect",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, "invalid", 9999);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Invalid IP");
    });

    it("engineConnect returns error on API throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("network error"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineConnect",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, "127.0.0.1", 8080);
      expect(result.success).toBe(false);
      expect(result.error).toBe("network error");
    });

    it("engineDisconnect returns error on API throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("disconnect failed"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineDisconnect",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.success).toBe(false);
      expect(result.error).toBe("disconnect failed");
    });

    it("engineGetStatus returns error state on API throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("status failed"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineGetStatus",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.success).toBe(false);
      expect(result.state).toEqual(
        expect.objectContaining({
          status: "error",
          macros: [],
          error: "status failed",
        }),
      );
    });

    it("engineGetMacros returns failure when API returns success false", async () => {
      mockBridgeApiRequest.mockResolvedValueOnce({
        success: false,
        error: "Not connected",
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineGetMacros",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.success).toBe(false);
      expect(result.error).toBe("Not connected");
    });

    it("engineGetMacros returns error on throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("macros failed"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineGetMacros",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.success).toBe(false);
      expect(result.error).toBe("macros failed");
      expect(result.macros).toEqual([]);
    });

    it("engineRunMacro returns failure when API returns success false", async () => {
      mockBridgeApiRequest.mockResolvedValueOnce({
        success: false,
        error: "Macro not found",
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineRunMacro",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Macro not found");
    });

    it("engineRunMacro returns error on throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("run failed"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineRunMacro",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("run failed");
    });

    it("engineStopMacro returns failure when API returns success false", async () => {
      mockBridgeApiRequest.mockResolvedValueOnce({
        success: false,
        message: "Already stopped",
      });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineStopMacro",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("Already stopped");
    });

    it("engineStopMacro returns error on throw", async () => {
      mockBridgeApiRequest.mockRejectedValueOnce(new Error("stop failed"));
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "engineStopMacro",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler(undefined, 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe("stop failed");
    });

    it("bridgeGetOutputs returns empty and logs error when fetch returns null", async () => {
      mockFetchBridgeOutputs.mockResolvedValueOnce(null);
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetOutputs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      const result = await handler();
      expect(mockLogAppError).toHaveBeenCalledWith(
        "bridgeGetOutputs failed: bridge running but outputs null",
      );
      expect(result).toEqual({ output1: [], output2: [] });
    });

    it("bridgeGetOutputs returns empty when config is null", async () => {
      mockGetConfig.mockReturnValueOnce(null);
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetOutputs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result).toEqual({ output1: [], output2: [] });
    });

    it("bridgeGetOutputs returns outputs from bridge when fetch succeeds", async () => {
      const outputs = {
        output1: [{ id: "1", label: "Out 1", available: true }],
        output2: [],
      };
      mockFetchBridgeOutputs.mockResolvedValueOnce(outputs);
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetOutputs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result).toEqual(outputs);
    });

    it("bridgeGetLogs logs error when response has error", async () => {
      mockFetchBridgeLogs.mockResolvedValueOnce({ lines: [], error: "fetch failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeGetLogs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      await handler(undefined, { lines: 100 });
      expect(mockLogAppError).toHaveBeenCalledWith(
        "bridgeGetLogs failed: fetch failed",
      );
    });

    it("appGetLogs logs error when response has error", async () => {
      mockReadAppLogs.mockResolvedValueOnce({ lines: [], error: "read failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "appGetLogs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      await handler(undefined, { lines: 50 });
      expect(mockLogAppError).toHaveBeenCalledWith("appGetLogs failed: read failed");
    });

    it("bridgeClearLogs logs error when response has error", async () => {
      mockClearBridgeLogs.mockResolvedValueOnce({ error: "clear failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "bridgeClearLogs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      await handler();
      expect(mockLogAppError).toHaveBeenCalledWith(
        "bridgeClearLogs failed: clear failed",
      );
    });

    it("appClearLogs logs error when response has error", async () => {
      mockClearAppLogs.mockResolvedValueOnce({ error: "clear failed" });
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "appClearLogs",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      mockLogAppError.mockClear();
      await handler();
      expect(mockLogAppError).toHaveBeenCalledWith("appClearLogs failed: clear failed");
    });

    it("openExternal does not call shell when URL not allowed", async () => {
      const { shell } = await import("electron");
      mockIsAllowedExternalUrl.mockReturnValueOnce(false);
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "openExternal",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      (shell.openExternal as jest.Mock).mockClear();
      await handler(undefined, "https://evil.com");
      expect(shell.openExternal).not.toHaveBeenCalled();
    });

    it("window close handler stops health check and bridge", async () => {
      await readyHandlers[0]();
      const { BrowserWindow } = await import("electron");
      const win = (BrowserWindow as jest.Mock).mock.results[0].value;
      const closeCb = win.on.mock.calls.find((c: unknown[]) => c[0] === "close")?.[1];
      expect(closeCb).toBeDefined();
      mockStop.mockClear();
      await closeCb();
      expect(mockStop).toHaveBeenCalled();
    });

    it("loads dev URL when isDev returns true", async () => {
      mockIsDev.mockReturnValue(true);
      jest.resetModules();
      await import("./main.js");
      const lastReady = readyHandlers[readyHandlers.length - 1];
      await lastReady();
      const { BrowserWindow } = await import("electron");
      const results = (BrowserWindow as jest.Mock).mock.results;
      const win = results[results.length - 1]?.value;
      expect(win).toBeDefined();
      expect(win.loadURL).toHaveBeenCalledWith(
        expect.stringMatching(/^http:\/\/localhost:\d+$/),
      );
      expect(win.loadFile).not.toHaveBeenCalled();
    });
  });

  describe("loadNetworkConfig from user file", () => {
    beforeEach(async () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.includes("network-config.json") && p.includes("userData"),
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          networkBinding: { default: {}, options: [] },
          port: { default: 9999 },
        }),
      );
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
    });

    it("getNetworkConfig returns user config when file exists", async () => {
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "getNetworkConfig",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.port.default).toBe(9999);
    });
  });

  describe("loadNetworkConfig from template", () => {
    it("getNetworkConfig returns template when template exists and user file missing", async () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.includes("network-config.json") && p.includes("config"),
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          networkBinding: { default: {}, options: [] },
          port: { default: 8888 },
        }),
      );
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "getNetworkConfig",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.port.default).toBe(8888);
    });

    it("getNetworkConfig uses template in memory when writeFileSync fails", async () => {
      mockExistsSync.mockImplementation((p: string) =>
        p.includes("network-config.json") && p.includes("config"),
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          networkBinding: { default: {}, options: [] },
          port: { default: 7777 },
        }),
      );
      mockWriteFileSync.mockImplementationOnce(() => {
        throw new Error("write failed");
      });
      jest.resetModules();
      await import("./main.js");
      await readyHandlers[0]();
      const idx = mockIpcMainHandle.mock.calls.findIndex(
        (c: unknown[]) => c[0] === "getNetworkConfig",
      );
      const handler = mockIpcMainHandle.mock.calls[idx][1];
      const result = await handler();
      expect(result.port.default).toBe(7777);
    });
  });

  describe("single instance lock", () => {
    it("quits when lock not acquired", async () => {
      singleInstanceLockReturns = false;
      mockAppQuit.mockClear();
      mockRequestSingleInstanceLock.mockClear();
      jest.resetModules();
      process.argv = ["electron", "/app"];
      await import("./main.js");
      expect(mockRequestSingleInstanceLock).toHaveBeenCalled();
      expect(mockAppQuit).toHaveBeenCalled();
      singleInstanceLockReturns = true;
    });
  });
});

describe("main graphics-renderer path", () => {
  const originalArgv = process.argv;

  afterEach(() => {
    process.argv = originalArgv;
  });

  it("exits with code 1 when graphics-renderer set but no renderer-entry", async () => {
    process.argv = ["electron", "/app", "--graphics-renderer"];
    jest.resetModules();
    const consoleSpy = jest.spyOn(console, "error").mockImplementation();
    await import("./main.js");
    expect(mockAppExit).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
  });
});
