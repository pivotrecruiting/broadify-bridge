import { setBridgeContext } from "../bridge-context.js";
import { GraphicsError } from "./graphics-errors.js";
import { GraphicsManager } from "./graphics-manager.js";
import { GraphicsOutputTransitionError } from "./graphics-output-transition-service.js";
import { GRAPHICS_OUTPUT_CONFIG_VERSION } from "./graphics-schemas.js";
import type { GraphicsRenderer } from "./renderer/graphics-renderer.js";

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
});
