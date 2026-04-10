import { setBridgeContext } from "../bridge-context.js";
import { GraphicsRuntimeInitService } from "./graphics-runtime-init-service.js";

const mockAssetRegistryInit = jest.fn().mockResolvedValue(undefined);
const mockOutputStoreInit = jest.fn().mockResolvedValue(undefined);
const mockGetConfig = jest.fn().mockReturnValue(null);
const mockClear = jest.fn().mockResolvedValue(undefined);

jest.mock("./asset-registry.js", () => ({
  assetRegistry: {
    initialize: () => mockAssetRegistryInit(),
    getAssetMap: () => ({}),
  },
}));

jest.mock("./output-config-store.js", () => ({
  outputConfigStore: {
    initialize: () => mockOutputStoreInit(),
    getConfig: () => mockGetConfig(),
    clear: () => mockClear(),
  },
}));

describe("GraphicsRuntimeInitService", () => {
  const mockLogger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
    });
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue(null);
  });

  it("initializes asset registry and output config store", async () => {
    const getRenderer = jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      setAssets: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      configureSession: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    });
    const setRenderer = jest.fn();
    const setOutputAdapter = jest.fn();
    const setOutputConfig = jest.fn();
    const createStubRenderer = jest.fn().mockReturnValue({
      initialize: jest.fn().mockResolvedValue(undefined),
      setAssets: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      configureSession: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    });
    const createStubOutputAdapter = jest.fn().mockReturnValue({
      configure: jest.fn(),
      stop: jest.fn(),
      sendFrame: jest.fn(),
    });

    const service = new GraphicsRuntimeInitService({
      getRenderer,
      setRenderer,
      setOutputAdapter,
      setOutputConfig,
      createStubRenderer,
      createStubOutputAdapter,
      selectOutputAdapter: jest.fn(),
      applyFrameBusConfig: jest.fn(),
      buildRendererConfig: jest.fn().mockReturnValue({}),
      publishGraphicsError: jest.fn(),
    });

    await service.initialize();

    expect(mockAssetRegistryInit).toHaveBeenCalled();
    expect(mockOutputStoreInit).toHaveBeenCalled();
    expect(getRenderer().initialize).toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining("Renderer initialized")
    );
  });

  it("falls back to stub renderer when init fails", async () => {
    const stubRenderer = {
      initialize: jest.fn().mockResolvedValue(undefined),
      setAssets: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      configureSession: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    };
    const getRenderer = jest.fn().mockReturnValue({
      initialize: jest.fn().mockRejectedValue(new Error("init failed")),
      setAssets: jest.fn(),
      onError: jest.fn(),
      configureSession: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    });
    const setRenderer = jest.fn();

    const service = new GraphicsRuntimeInitService({
      getRenderer,
      setRenderer,
      setOutputAdapter: jest.fn(),
      setOutputConfig: jest.fn(),
      createStubRenderer: () => stubRenderer as never,
      createStubOutputAdapter: jest.fn(),
      selectOutputAdapter: jest.fn(),
      applyFrameBusConfig: jest.fn(),
      buildRendererConfig: jest.fn().mockReturnValue({}),
      publishGraphicsError: jest.fn(),
    });

    await service.initialize();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Renderer init failed, falling back to stub")
    );
    expect(setRenderer).toHaveBeenCalledWith(stubRenderer);
    expect(stubRenderer.initialize).toHaveBeenCalled();
  });

  it("applies persisted output config when present", async () => {
    const persistedConfig = {
      version: 1 as const,
      outputKey: "stub" as const,
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal" as const,
      colorspace: "auto" as const,
    };
    mockGetConfig.mockReturnValue(persistedConfig);

    const setOutputConfig = jest.fn();
    const applyFrameBusConfig = jest.fn();
    const buildRendererConfig = jest.fn().mockReturnValue({});
    const mockAdapter = {
      configure: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      sendFrame: jest.fn(),
    };
    const selectOutputAdapter = jest.fn().mockResolvedValue(mockAdapter);

    const renderer = {
      initialize: jest.fn().mockResolvedValue(undefined),
      configureSession: jest.fn().mockResolvedValue(undefined),
      setAssets: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    };

    const service = new GraphicsRuntimeInitService({
      getRenderer: () => renderer as never,
      setRenderer: jest.fn(),
      setOutputAdapter: jest.fn(),
      setOutputConfig,
      createStubRenderer: jest.fn(),
      createStubOutputAdapter: jest.fn().mockReturnValue({}),
      selectOutputAdapter,
      applyFrameBusConfig,
      buildRendererConfig,
      publishGraphicsError: jest.fn(),
    });

    await service.initialize();

    expect(setOutputConfig).toHaveBeenCalledWith(persistedConfig);
    expect(applyFrameBusConfig).toHaveBeenCalledWith(persistedConfig);
    expect(renderer.configureSession).toHaveBeenCalled();
    expect(selectOutputAdapter).toHaveBeenCalledWith(persistedConfig);
    expect(mockAdapter.configure).toHaveBeenCalledWith(persistedConfig);
  });

  it("on persisted config failure falls back to stub and clears store", async () => {
    mockGetConfig.mockReturnValue({
      version: 1,
      outputKey: "stub",
      targets: {},
      format: { width: 1920, height: 1080, fps: 50 },
      range: "legal",
      colorspace: "auto",
    });
    const setOutputConfig = jest.fn();
    const setOutputAdapter = jest.fn();
    const stubAdapter = { configure: jest.fn(), stop: jest.fn(), sendFrame: jest.fn() };
    const createStubOutputAdapter = jest.fn().mockReturnValue(stubAdapter);
    const renderer = {
      initialize: jest.fn().mockResolvedValue(undefined),
      configureSession: jest.fn().mockRejectedValue(new Error("session failed")),
      setAssets: jest.fn().mockResolvedValue(undefined),
      onError: jest.fn(),
      renderLayer: jest.fn(),
      updateValues: jest.fn(),
      updateLayout: jest.fn(),
      removeLayer: jest.fn(),
      shutdown: jest.fn(),
    };

    const service = new GraphicsRuntimeInitService({
      getRenderer: () => renderer as never,
      setRenderer: jest.fn(),
      setOutputAdapter,
      setOutputConfig,
      createStubRenderer: jest.fn(),
      createStubOutputAdapter,
      selectOutputAdapter: jest.fn().mockResolvedValue({ configure: jest.fn(), stop: jest.fn(), sendFrame: jest.fn() }),
      applyFrameBusConfig: jest.fn(),
      buildRendererConfig: jest.fn().mockReturnValue({}),
      publishGraphicsError: jest.fn(),
    });

    await service.initialize();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to apply persisted output config")
    );
    expect(setOutputConfig).toHaveBeenCalledWith(null);
    expect(setOutputAdapter).toHaveBeenCalledWith(stubAdapter);
    expect(mockClear).toHaveBeenCalled();
  });
});
