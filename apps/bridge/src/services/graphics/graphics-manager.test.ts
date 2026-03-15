import { getBridgeContext, setBridgeContext } from "../bridge-context.js";
import { GraphicsError } from "./graphics-errors.js";
import { GraphicsManager } from "./graphics-manager.js";
import { GraphicsOutputTransitionError } from "./graphics-output-transition-service.js";
import { GRAPHICS_OUTPUT_CONFIG_VERSION } from "./graphics-schemas.js";
import { createTestPatternPayload } from "./test-pattern.js";
import type { GraphicsRenderer } from "./renderer/graphics-renderer.js";

const mockAssetStore = jest.fn().mockResolvedValue(undefined);
const mockAssetGet = jest.fn().mockReturnValue(null);
const mockAssetGetMap = jest.fn().mockReturnValue({});
const mockAssetInit = jest.fn().mockResolvedValue(undefined);
jest.mock("./asset-registry.js", () => ({
  assetRegistry: {
    initialize: () => mockAssetInit(),
    storeAsset: (...args: unknown[]) => mockAssetStore(...args),
    getAsset: (id: string) => mockAssetGet(id),
    getAssetMap: () => mockAssetGetMap(),
  },
}));

const mockOutputStoreInit = jest.fn().mockResolvedValue(undefined);
const mockOutputStoreSet = jest.fn().mockResolvedValue(undefined);
const mockOutputStoreClear = jest.fn().mockResolvedValue(undefined);
const mockOutputStoreGetConfig = jest.fn().mockReturnValue(null);
jest.mock("./output-config-store.js", () => ({
  outputConfigStore: {
    initialize: () => mockOutputStoreInit(),
    setConfig: (...args: unknown[]) => mockOutputStoreSet(...args),
    clear: () => mockOutputStoreClear(),
    getConfig: () => mockOutputStoreGetConfig(),
  },
}));

const mockSanitizeCss = jest.fn((css: string) => css);
const mockValidateTemplate = jest.fn(() => ({ assetIds: new Set<string>() }));
jest.mock("./template-sanitizer.js", () => ({
  sanitizeTemplateCss: (css: string) => mockSanitizeCss(css),
  validateTemplate: (html: string, css: string) => mockValidateTemplate(html, css),
}));

const createRenderer = (): GraphicsRenderer => ({
  initialize: jest.fn(async () => undefined),
  configureSession: jest.fn(async () => undefined),
  setAssets: jest.fn(async () => undefined),
  renderLayer: jest.fn(async () => undefined),
  updateValues: jest.fn(async () => undefined),
  updateLayout: jest.fn(async () => undefined),
  removeLayer: jest.fn(async () => undefined),
  onError: jest.fn(),
  shutdown: jest.fn(async () => undefined),
});

const createValidConfig = () => ({
  version: GRAPHICS_OUTPUT_CONFIG_VERSION,
  outputKey: "stub" as const,
  targets: {},
  format: {
    width: 1920,
    height: 1080,
    fps: 50,
  },
  range: "legal" as const,
  colorspace: "auto" as const,
});

describe("GraphicsManager", () => {
  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp/bridge-data",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
  });

  it("initializes runtime only once", async () => {
    const initialize = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize,
      },
    });

    await manager.initialize();
    await manager.initialize();

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid output config payloads before transition", async () => {
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
    });

    await expect(manager.configureOutputs({})).rejects.toMatchObject({
      code: "output_config_error",
    });
    expect(runAtomicTransition).not.toHaveBeenCalled();
  });

  it("rejects unsupported config versions", async () => {
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
    });

    await expect(
      manager.configureOutputs({
        ...createValidConfig(),
        version: GRAPHICS_OUTPUT_CONFIG_VERSION + 1,
      })
    ).rejects.toMatchObject({
      code: "output_config_error",
    });
    expect(runAtomicTransition).not.toHaveBeenCalled();
  });

  it("skips output validation in development mode and applies the transition", async () => {
    const validateOutputTargets = jest.fn(async () => undefined);
    const validateOutputFormat = jest.fn(async () => undefined);
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
      isDevelopmentMode: () => true,
      validateOutputTargets,
      validateOutputFormat,
    });

    await manager.configureOutputs(createValidConfig());

    expect(validateOutputTargets).not.toHaveBeenCalled();
    expect(validateOutputFormat).not.toHaveBeenCalled();
    expect(runAtomicTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        outputKey: "stub",
      })
    );
  });

  it("maps renderer transition failures to renderer_error", async () => {
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => {
          throw new GraphicsOutputTransitionError(
            "renderer_configure",
            "renderer failed"
          );
        }),
      },
      isDevelopmentMode: () => true,
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "renderer_error",
        message: "renderer failed",
      })
    );
  });

  it("rejects sendLayer when outputs are not configured", async () => {
    const waitForTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition,
        runAtomicTransition: jest.fn(async () => undefined),
      },
    });

    await expect(manager.sendLayer({})).rejects.toThrow("Outputs not configured");
    expect(waitForTransition).toHaveBeenCalledTimes(1);
  });

  it("rejects when validateOutputTargets throws in production mode", async () => {
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
      isDevelopmentMode: () => false,
      validateOutputTargets: jest
        .fn()
        .mockRejectedValue(new Error("target validation failed")),
      validateOutputFormat: jest.fn(async () => undefined),
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "output_config_error",
        message: "target validation failed",
      })
    );
    expect(runAtomicTransition).not.toHaveBeenCalled();
  });

  it("rejects when validateOutputFormat throws in production mode", async () => {
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
      isDevelopmentMode: () => false,
      validateOutputTargets: jest.fn(async () => undefined),
      validateOutputFormat: jest
        .fn()
        .mockRejectedValue(new Error("format validation failed")),
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "output_config_error",
        message: "format validation failed",
      })
    );
    expect(runAtomicTransition).not.toHaveBeenCalled();
  });

  it("calls validateOutputTargets and validateOutputFormat when not in development mode", async () => {
    const validateOutputTargets = jest.fn(async () => undefined);
    const validateOutputFormat = jest.fn(async () => undefined);
    const runAtomicTransition = jest.fn(async () => undefined);
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition,
      },
      isDevelopmentMode: () => false,
      validateOutputTargets,
      validateOutputFormat,
    });

    await manager.configureOutputs(createValidConfig());

    expect(validateOutputTargets).toHaveBeenCalledWith(
      "stub",
      {},
      expect.objectContaining({ currentOutputConfig: null })
    );
    expect(validateOutputFormat).toHaveBeenCalledWith(
      "stub",
      {},
      expect.objectContaining({ width: 1920, height: 1080, fps: 50 })
    );
    expect(runAtomicTransition).toHaveBeenCalledWith(
      expect.objectContaining({ outputKey: "stub" })
    );
  });

  it("getStatus returns outputConfig null and activePreset null when not configured", async () => {
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: {
        initialize: jest.fn(async () => undefined),
      },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => undefined),
      },
    });
    await manager.initialize();

    const status = manager.getStatus();

    expect(status).toHaveProperty("outputConfig", null);
    expect(status).toHaveProperty("layers");
    expect(Array.isArray(status.layers)).toBe(true);
    expect(status).toHaveProperty("activePreset", null);
    expect(status).toHaveProperty("activePresets");
    expect(Array.isArray(status.activePresets)).toBe(true);
  });

  it("maps persist transition failures to output_config_error", async () => {
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => {
          throw new GraphicsOutputTransitionError("persist", "disk full");
        }),
      },
      isDevelopmentMode: () => true,
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "output_config_error",
        message: "disk full",
      })
    );
  });

  it("maps generic transition errors to output_config_error", async () => {
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => {
          throw new Error("unexpected transition error");
        }),
      },
      isDevelopmentMode: () => true,
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "output_config_error",
        message: "unexpected transition error",
      })
    );
  });

  it("maps output_helper transition failures to output_helper_error", async () => {
    const manager = new GraphicsManager({
      createRenderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => {
          throw new GraphicsOutputTransitionError(
            "next_adapter_configure",
            "adapter failed"
          );
        }),
      },
      isDevelopmentMode: () => true,
    });

    await expect(manager.configureOutputs(createValidConfig())).rejects.toEqual(
      expect.objectContaining<Partial<GraphicsError>>({
        code: "output_helper_error",
        message: "adapter failed",
      })
    );
  });

  it("handles output adapter stop failure during shutdown", async () => {
    const stubAdapterForShutdown = {
      configure: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockRejectedValue(new Error("stop failed")),
      sendFrame: jest.fn(),
    };
    const manager = new GraphicsManager({
      createRenderer,
      selectOutputAdapter: async () => stubAdapterForShutdown as never,
      isDevelopmentMode: () => true,
    });
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    const logger = getBridgeContext().logger as { warn: jest.Mock };
    await manager.shutdown();

    expect(stubAdapterForShutdown.stop).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Output adapter stop failed")
    );
  });

  it("handles renderer shutdown failure during shutdown", async () => {
    const renderer = createRenderer();
    (renderer.shutdown as jest.Mock).mockRejectedValueOnce(
      new Error("shutdown failed")
    );
    const manager = new GraphicsManager({
      createRenderer: () => renderer,
      runtimeInitService: { initialize: jest.fn(async () => undefined) },
      outputTransitionService: {
        waitForTransition: jest.fn(async () => undefined),
        runAtomicTransition: jest.fn(async () => undefined),
      },
    });
    await manager.initialize();

    const logger = getBridgeContext().logger as { warn: jest.Mock };
    await manager.shutdown();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Renderer shutdown failed")
    );
  });
});

describe("GraphicsManager with configured outputs", () => {
  const stubAdapter = {
    configure: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    sendFrame: jest.fn(),
  };

  function createManagerWithRealTransition(renderer?: GraphicsRenderer) {
    const r = renderer ?? createRenderer();
    return new GraphicsManager({
      createRenderer: () => r,
      selectOutputAdapter: async () => stubAdapter as never,
      isDevelopmentMode: () => true,
    });
  }

  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp/bridge-data",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
    jest.clearAllMocks();
    mockValidateTemplate.mockReturnValue({ assetIds: new Set<string>() });
  });

  it("sendLayer succeeds after configureOutputs and renders layer", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    const payload = createTestPatternPayload();
    await manager.sendLayer(payload);

    const status = manager.getStatus();
    expect(status.outputConfig).not.toBeNull();
    expect(status.layers).toHaveLength(1);
    expect(status.layers[0]).toMatchObject({
      layerId: "test-pattern",
      category: "overlays",
    });
  });

  it("sendLayer rejects when durationMs is set without presetId", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    const payload = {
      ...createTestPatternPayload(),
      durationMs: 5000,
      presetId: undefined,
    };

    await expect(manager.sendLayer(payload)).rejects.toThrow(
      "Preset ID is required when durationMs is set"
    );
  });

  it("sendLayer logs format mismatch when bundle manifest render differs from output", async () => {
    const manager = createManagerWithRealTransition();
    const logger = getBridgeContext().logger as { warn: jest.Mock };
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    const payload = {
      ...createTestPatternPayload(),
      bundle: {
        ...createTestPatternPayload().bundle,
        manifest: {
          ...createTestPatternPayload().bundle.manifest,
          render: { width: 1280, height: 720, fps: 60 },
        },
      },
    };
    await manager.sendLayer(payload);

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Bundle manifest render format mismatch")
    );
  });

  it("sendLayer rejects invalid payload schema", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    await expect(manager.sendLayer({ invalid: "payload" })).rejects.toThrow();
  });

  it("updateValues updates layer values", async () => {
    const renderer = createRenderer();
    const manager = createManagerWithRealTransition(renderer);
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer(createTestPatternPayload());

    await manager.updateValues({
      layerId: "test-pattern",
      values: { title: "Updated" },
    });

    expect(renderer.updateValues).toHaveBeenCalledWith(
      "test-pattern",
      expect.objectContaining({ title: "Updated" }),
      expect.any(Object)
    );
  });

  it("updateValues throws when layer not found", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    await expect(
      manager.updateValues({
        layerId: "nonexistent",
        values: { x: 1 },
      })
    ).rejects.toThrow("Layer not found");
  });

  it("updateLayout updates layer layout", async () => {
    const renderer = createRenderer();
    const manager = createManagerWithRealTransition(renderer);
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer(createTestPatternPayload());

    await manager.updateLayout({
      layerId: "test-pattern",
      layout: { x: 100, y: 200, scale: 1.5 },
      zIndex: 10,
    });

    expect(renderer.updateLayout).toHaveBeenCalledWith(
      "test-pattern",
      { x: 100, y: 200, scale: 1.5 },
      10
    );
  });

  it("updateLayout throws when layer not found", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    await expect(
      manager.updateLayout({
        layerId: "nonexistent",
        layout: { x: 0, y: 0, scale: 1 },
      })
    ).rejects.toThrow("Layer not found");
  });

  it("removeLayer returns early when layer not found", async () => {
    const renderer = createRenderer();
    const manager = createManagerWithRealTransition(renderer);
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());

    await manager.removeLayer({ layerId: "nonexistent" });

    expect(renderer.removeLayer).not.toHaveBeenCalled();
  });

  it("removeLayer removes existing layer", async () => {
    const renderer = createRenderer();
    const manager = createManagerWithRealTransition(renderer);
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer(createTestPatternPayload());

    await manager.removeLayer({ layerId: "test-pattern" });

    expect(renderer.removeLayer).toHaveBeenCalledWith("test-pattern");
    const status = manager.getStatus();
    expect(status.layers).toHaveLength(0);
  });

  it("removePreset removes preset by id", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer({
      ...createTestPatternPayload(),
      presetId: "preset-1",
      durationMs: 10000,
    });

    await manager.removePreset({ presetId: "preset-1" });

    const status = manager.getStatus();
    expect(status.activePreset).toBeNull();
  });

  it("sendTestPattern clears layers and sends test pattern", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer(createTestPatternPayload());

    await manager.sendTestPattern();

    const status = manager.getStatus();
    expect(status.layers).toHaveLength(1);
    expect(status.layers[0].layerId).toBe("test-pattern");
  });

  it("getStatus returns activePreset when preset is active", async () => {
    const manager = createManagerWithRealTransition();
    await manager.initialize();
    await manager.configureOutputs(createValidConfig());
    await manager.sendLayer({
      ...createTestPatternPayload(),
      presetId: "preset-1",
      durationMs: 5000,
    });

    const status = manager.getStatus();

    expect(status.activePreset).not.toBeNull();
    expect(status.activePreset?.presetId).toBe("preset-1");
    expect(status.activePresets).toHaveLength(1);
  });
});
