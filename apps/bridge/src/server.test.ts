import type { BridgeConfigT } from "./config.js";

const mockResolveUserDataDir = jest.fn();
const mockSetBridgeContext = jest.fn();
const mockEnsureBridgeLogFile = jest.fn();
const mockBindConsoleToLogger = jest.fn();
const mockLogRuntimeDiagnostics = jest.fn();
const mockRegisterServerPlugins = jest.fn();
const mockRegisterServerRoutes = jest.fn();
const mockInitializeModules = jest.fn();
const mockNormalizeLevel = jest.fn();
const mockClampMaxLevel = jest.fn();

const mockGraphicsInitialize = jest.fn().mockResolvedValue(undefined);
const mockGraphicsShutdown = jest.fn().mockResolvedValue(undefined);
const mockDeviceCacheInitializeWatchers = jest.fn();

const mockRelayConnect = jest.fn().mockResolvedValue(undefined);
const mockRelayDisconnect = jest.fn().mockResolvedValue(undefined);
const mockRelaySendBridgeEvent = jest.fn();
const MockRelayClient = jest.fn().mockImplementation(() => ({
  connect: mockRelayConnect,
  disconnect: mockRelayDisconnect,
  sendBridgeEvent: mockRelaySendBridgeEvent,
}));

const mockListen = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);
const mockRegister = jest.fn().mockResolvedValue(undefined);

const mockLog = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const mockServerInstance = {
  server: {
    requestTimeout: 0,
    headersTimeout: 0,
  },
  log: mockLog,
  register: mockRegister,
  listen: mockListen,
  close: mockClose,
};

const mockFastify = jest.fn().mockReturnValue(mockServerInstance);

const mockPinoDestination = jest.fn().mockReturnValue({});
const mockPinoMultistream = jest.fn().mockReturnValue([]);
const mockPinoLogger = {
  child: jest.fn().mockReturnThis(),
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};
const mockPino = jest.fn().mockReturnValue(mockPinoLogger);
(mockPino as unknown as { multistream: jest.Mock }).multistream =
  mockPinoMultistream;
(mockPino as unknown as { destination: jest.Mock }).destination =
  mockPinoDestination;

jest.mock("./services/bridge-context.js", () => ({
  resolveUserDataDir: (...args: unknown[]) => mockResolveUserDataDir(...args),
  setBridgeContext: (...args: unknown[]) => mockSetBridgeContext(...args),
}));

jest.mock("./services/log-file.js", () => ({
  ensureBridgeLogFile: (...args: unknown[]) =>
    mockEnsureBridgeLogFile(...args),
}));

jest.mock("./services/console-to-pino.js", () => ({
  bindConsoleToLogger: (...args: unknown[]) => mockBindConsoleToLogger(...args),
}));

jest.mock("./services/runtime-diagnostics.js", () => ({
  logRuntimeDiagnostics: (...args: unknown[]) =>
    mockLogRuntimeDiagnostics(...args),
}));

jest.mock("./services/graphics/graphics-manager.js", () => ({
  graphicsManager: {
    initialize: (...args: unknown[]) => mockGraphicsInitialize(...args),
    shutdown: (...args: unknown[]) => mockGraphicsShutdown(...args),
  },
}));

jest.mock("./server-registration.js", () => ({
  registerServerPlugins: (...args: unknown[]) =>
    mockRegisterServerPlugins(...args),
  registerServerRoutes: (...args: unknown[]) =>
    mockRegisterServerRoutes(...args),
}));

jest.mock("./modules/index.js", () => ({
  initializeModules: (...args: unknown[]) => mockInitializeModules(...args),
}));

jest.mock("./services/device-cache.js", () => ({
  deviceCache: {
    initializeWatchers: (...args: unknown[]) =>
      mockDeviceCacheInitializeWatchers(...args),
  },
}));

jest.mock("./services/relay-client.js", () => ({
  RelayClient: MockRelayClient,
}));

jest.mock("./services/log-level-utils.js", () => ({
  normalizeLevel: (...args: unknown[]) => mockNormalizeLevel(...args),
  clampMaxLevel: (...args: unknown[]) => mockClampMaxLevel(...args),
}));

jest.mock("fastify", () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFastify(...args),
}));

jest.mock("pino", () => ({
  __esModule: true,
  default: Object.assign(mockPino, {
    multistream: mockPinoMultistream,
    destination: mockPinoDestination,
  }),
}));

const originalEnv = process.env;
const originalExit = process.exit;
const originalOn = process.on;
const exitSpy = jest.fn();
const onHandlers: { [key: string]: ((...args: unknown[]) => void)[] } = {};

function createBaseConfig(overrides: Partial<BridgeConfigT> = {}): BridgeConfigT {
  return {
    host: "127.0.0.1",
    port: 8787,
    mode: "local",
    ...overrides,
  };
}

describe("server", () => {
  beforeAll(() => {
    (process as NodeJS.Process & { exit: (code?: number) => void }).exit =
      exitSpy as unknown as (code?: number) => never;
    process.on = jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!onHandlers[event]) onHandlers[event] = [];
      onHandlers[event].push(handler);
      return process;
    }) as typeof process.on;
  });

  afterAll(() => {
    process.env = originalEnv;
    (process as NodeJS.Process & { exit: typeof originalExit }).exit =
      originalExit;
    process.on = originalOn;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy.mockClear();
    Object.keys(onHandlers).forEach((k) => delete onHandlers[k]);
    mockResolveUserDataDir.mockReturnValue("/tmp/bridge-data");
    mockEnsureBridgeLogFile.mockResolvedValue("/tmp/bridge-data/logs/bridge.log");
    mockNormalizeLevel.mockImplementation((_v: string | undefined, fallback: string) => fallback);
    mockClampMaxLevel.mockImplementation((_v: string, max: string) => max);
    process.env = { ...originalEnv };
  });

  describe("createServer", () => {
    it("resolves userDataDir and ensures log file", async () => {
      const { createServer } = await import("./server.js");
      const config = createBaseConfig({ userDataDir: "/custom/data" });
      mockResolveUserDataDir.mockReturnValue("/custom/data");

      await createServer(config);

      expect(mockResolveUserDataDir).toHaveBeenCalledWith(config);
      expect(mockEnsureBridgeLogFile).toHaveBeenCalledWith("/custom/data");
    });

    it("uses default userDataDir when not in config", async () => {
      const { createServer } = await import("./server.js");
      const config = createBaseConfig();
      mockResolveUserDataDir.mockReturnValue("/default/.bridge-data");

      await createServer(config);

      expect(mockEnsureBridgeLogFile).toHaveBeenCalledWith("/default/.bridge-data");
    });

    it("builds logger with normalized levels from env", async () => {
      process.env.BRIDGE_LOG_LEVEL = "debug";
      process.env.NODE_ENV = "development";
      mockNormalizeLevel
        .mockReturnValueOnce("debug")
        .mockReturnValueOnce("debug")
        .mockReturnValueOnce("debug");

      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockNormalizeLevel).toHaveBeenCalledWith("debug", "info");
      expect(mockPino).toHaveBeenCalledWith(
        { level: "debug" },
        expect.any(Array)
      );
    });

    it("clamps log level in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.BRIDGE_LOG_LEVEL = "trace";
      mockNormalizeLevel.mockReturnValue("trace");
      mockClampMaxLevel.mockReturnValue("info");

      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockClampMaxLevel).toHaveBeenCalled();
      expect(mockPino).toHaveBeenCalledWith(
        { level: "info" },
        expect.any(Array)
      );
    });

    it("binds console to logger and sets bridge context", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockBindConsoleToLogger).toHaveBeenCalledWith(mockPinoLogger);
      expect(mockSetBridgeContext).toHaveBeenCalledTimes(2);
      const firstContext = mockSetBridgeContext.mock.calls[0][0] as {
        userDataDir: string;
        logPath: string;
        bridgeId?: string;
      };
      expect(firstContext.userDataDir).toBe("/tmp/bridge-data");
      expect(firstContext.logPath).toBe("/tmp/bridge-data/logs/bridge.log");
    });

    it("creates Fastify with expected options", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockFastify).toHaveBeenCalledWith({
        logger: mockPinoLogger,
        disableRequestLogging: true,
        bodyLimit: 2 * 1024 * 1024,
        connectionTimeout: 15_000,
      });
      expect(mockServerInstance.server.requestTimeout).toBe(15_000);
      expect(mockServerInstance.server.headersTimeout).toBe(17_000);
    });

    it("calls logRuntimeDiagnostics with base context logger", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockLogRuntimeDiagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          debug: expect.any(Function),
          info: expect.any(Function),
          warn: expect.any(Function),
          error: expect.any(Function),
        })
      );
    });

    it("initializes graphics manager, plugins, modules and device watchers", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      expect(mockGraphicsInitialize).toHaveBeenCalled();
      expect(mockRegisterServerPlugins).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          corsPlugin: expect.anything(),
          websocketPlugin: expect.anything(),
        })
      );
      expect(mockInitializeModules).toHaveBeenCalled();
      expect(mockDeviceCacheInitializeWatchers).toHaveBeenCalled();
      expect(mockRegisterServerRoutes).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          config: expect.any(Object),
          routes: expect.objectContaining({
            registerStatusRoute: expect.any(Function),
            registerLogsRoute: expect.any(Function),
          }),
        })
      );
    });

    it("does not create RelayClient when relayDisabled", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig({ relayEnabled: false }));

      expect(MockRelayClient).not.toHaveBeenCalled();
      expect(mockSetBridgeContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          publishBridgeEvent: undefined,
        })
      );
    });

    it("does not create RelayClient when bridgeId is missing", async () => {
      const { createServer } = await import("./server.js");
      await createServer(
        createBaseConfig({ relayEnabled: true, bridgeId: undefined })
      );

      expect(MockRelayClient).not.toHaveBeenCalled();
    });

    it("creates RelayClient with default relayUrl when relayEnabled and bridgeId set", async () => {
      const { createServer } = await import("./server.js");
      const config = createBaseConfig({
        relayEnabled: true,
        bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        bridgeName: "Test Bridge",
      });

      await createServer(config);

      expect(MockRelayClient).toHaveBeenCalledWith(
        "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        "wss://broadify-relay.fly.dev",
        expect.objectContaining({
          debug: expect.any(Function),
          info: expect.any(Function),
          error: expect.any(Function),
          warn: expect.any(Function),
        }),
        "Test Bridge"
      );
    });

    it("creates RelayClient with custom relayUrl when provided", async () => {
      const { createServer } = await import("./server.js");
      const config = createBaseConfig({
        relayEnabled: true,
        bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        relayUrl: "wss://custom.relay.example",
      });

      await createServer(config);

      expect(MockRelayClient).toHaveBeenCalledWith(
        expect.any(String),
        "wss://custom.relay.example",
        expect.any(Object),
        undefined
      );
    });

    it("attaches relayClient to server instance", async () => {
      const { createServer } = await import("./server.js");
      const config = createBaseConfig({
        relayEnabled: true,
        bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      });

      const server = await createServer(config);

      expect((server as unknown as { relayClient: unknown }).relayClient).toBeDefined();
    });

    it("returns server instance", async () => {
      const { createServer } = await import("./server.js");
      const server = await createServer(createBaseConfig());

      expect(server).toBe(mockServerInstance);
      expect(server.log).toBe(mockLog);
      expect(server.listen).toBe(mockListen);
      expect(server.close).toBe(mockClose);
    });

    it("base context logger delegates to server.log", async () => {
      const { createServer } = await import("./server.js");
      await createServer(createBaseConfig());

      const firstContext = mockSetBridgeContext.mock.calls[0][0] as {
        logger: { debug: (m: string) => void; info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
      };
      firstContext.logger.info("info-msg");
      firstContext.logger.debug("debug-msg");
      firstContext.logger.warn("warn-msg");
      firstContext.logger.error("error-msg");

      expect(mockLog.info).toHaveBeenCalledWith("info-msg");
      expect(mockLog.debug).toHaveBeenCalledWith("debug-msg");
      expect(mockLog.warn).toHaveBeenCalledWith("warn-msg");
      expect(mockLog.error).toHaveBeenCalledWith("error-msg");
    });

    it("relay client receives logger that prefixes [Relay]", async () => {
      const { createServer } = await import("./server.js");
      await createServer(
        createBaseConfig({
          relayEnabled: true,
          bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        })
      );

      const relayLogger = MockRelayClient.mock.calls[0][2] as {
        debug: (m: string) => void;
        info: (m: string) => void;
        error: (m: string) => void;
        warn: (m: string) => void;
      };
      relayLogger.info("relay-msg");
      relayLogger.debug("relay-debug");
      relayLogger.error("relay-err");
      relayLogger.warn("relay-warn");

      expect(mockLog.info).toHaveBeenCalledWith("[Relay] relay-msg");
      expect(mockLog.debug).toHaveBeenCalledWith("[Relay] relay-debug");
      expect(mockLog.error).toHaveBeenCalledWith("[Relay] relay-err");
      expect(mockLog.warn).toHaveBeenCalledWith("[Relay] relay-warn");
    });

    it("publishBridgeEvent in context calls relayClient.sendBridgeEvent", async () => {
      const { createServer } = await import("./server.js");
      await createServer(
        createBaseConfig({
          relayEnabled: true,
          bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
        })
      );

      const secondContext = mockSetBridgeContext.mock.calls[1][0] as {
        publishBridgeEvent?: (p: { event: string; data?: unknown }) => void;
      };
      expect(secondContext.publishBridgeEvent).toBeDefined();
      secondContext.publishBridgeEvent!({ event: "test", data: { x: 1 } });

      expect(mockRelaySendBridgeEvent).toHaveBeenCalledWith({
        event: "test",
        data: { x: 1 },
      });
    });
  });

  describe("startServer", () => {
    it("listens on config host and port and logs", async () => {
      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({ host: "0.0.0.0", port: 9000 });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockListen).toHaveBeenCalledWith({
        host: "0.0.0.0",
        port: 9000,
      });
      expect(mockLog.info).toHaveBeenCalledWith(
        "Bridge server listening on http://0.0.0.0:9000"
      );
    });

    it("connects relay client after listen when present", async () => {
      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({
        relayEnabled: true,
        bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockRelayConnect).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        "[Server] Starting relay client connection..."
      );
    });

    it("does not connect relay when relayClient not attached", async () => {
      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig();
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockRelayConnect).not.toHaveBeenCalled();
    });

    it("calls process.exit(1) on EADDRINUSE", async () => {
      mockListen.mockRejectedValueOnce({ code: "EADDRINUSE" });

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({ port: 8787 });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockLog.error).toHaveBeenCalledWith(
        "Port 8787 is already in use. Please choose a different port."
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("falls back to 0.0.0.0 on EADDRNOTAVAIL and logs", async () => {
      mockListen
        .mockRejectedValueOnce({ code: "EADDRNOTAVAIL" })
        .mockResolvedValueOnce(undefined);

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({
        host: "192.168.1.100",
        port: 8787,
      });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockLog.warn).toHaveBeenCalledWith(
        "Address 192.168.1.100 not available, falling back to 0.0.0.0"
      );
      expect(mockListen).toHaveBeenLastCalledWith({
        host: "0.0.0.0",
        port: 8787,
      });
      expect(mockLog.info).toHaveBeenCalledWith(
        "Bridge server listening on http://0.0.0.0:8787 (fallback)"
      );
    });

    it("does not fallback when host is already 0.0.0.0 on EADDRNOTAVAIL", async () => {
      mockListen.mockRejectedValueOnce({ code: "EADDRNOTAVAIL" });

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({ host: "0.0.0.0", port: 8787 });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockListen).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) when fallback listen fails with EADDRINUSE", async () => {
      mockListen
        .mockRejectedValueOnce({ code: "EADDRNOTAVAIL" })
        .mockRejectedValueOnce({ code: "EADDRINUSE" });

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({
        host: "192.168.1.100",
        port: 8787,
      });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockLog.error).toHaveBeenCalledWith(
        "Port 8787 is already in use. Please choose a different port."
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("calls process.exit(1) when fallback listen fails with other error", async () => {
      const fallbackErr = new Error("Permission denied");
      mockListen
        .mockRejectedValueOnce({ code: "EADDRNOTAVAIL" })
        .mockRejectedValueOnce(fallbackErr);

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({
        host: "192.168.1.100",
        port: 8787,
      });
      const server = await createServer(config);

      await startServer(server, config);

      expect(mockLog.error).toHaveBeenCalledWith(
        "Fallback to 0.0.0.0 also failed:",
        fallbackErr
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("registers SIGTERM and SIGINT handlers", async () => {
      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig();
      const server = await createServer(config);

      await startServer(server, config);

      expect(process.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
      expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    });

    it("shutdown disconnects relay, shuts down graphics, closes server and exits 0", async () => {
      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig({
        relayEnabled: true,
        bridgeId: "aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee",
      });
      const server = await createServer(config);
      await startServer(server, config);

      const sigTermHandler = (process.on as jest.Mock).mock.calls.find(
        (c: [string, unknown]) => c[0] === "SIGTERM"
      )?.[1] as () => Promise<void>;
      expect(sigTermHandler).toBeDefined();
      await sigTermHandler();

      expect(mockLog.info).toHaveBeenCalledWith(
        "Received SIGTERM, shutting down gracefully..."
      );
      expect(mockRelayDisconnect).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith(
        "[Server] Disconnecting relay client..."
      );
      expect(mockGraphicsShutdown).toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalled();
      expect(mockLog.info).toHaveBeenCalledWith("Server closed");
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("shutdown logs graphics shutdown error but still closes and exits 0", async () => {
      mockGraphicsShutdown.mockRejectedValueOnce(new Error("Renderer busy"));

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig();
      const server = await createServer(config);
      await startServer(server, config);

      const sigIntHandler = (process.on as jest.Mock).mock.calls.find(
        (c: [string, unknown]) => c[0] === "SIGINT"
      )?.[1] as () => Promise<void>;
      await sigIntHandler();

      expect(mockLog.warn).toHaveBeenCalledWith(
        expect.stringContaining("[Graphics] Shutdown encountered an error:")
      );
      expect(mockClose).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("shutdown calls process.exit(1) on unexpected error", async () => {
      mockClose.mockRejectedValueOnce(new Error("Close failed"));

      const { createServer, startServer } = await import("./server.js");
      const config = createBaseConfig();
      const server = await createServer(config);
      await startServer(server, config);

      const sigTermHandler = (process.on as jest.Mock).mock.calls.find(
        (c: [string, unknown]) => c[0] === "SIGTERM"
      )?.[1] as () => Promise<void>;
      await sigTermHandler();

      expect(mockLog.error).toHaveBeenCalledWith(expect.any(Error));
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
