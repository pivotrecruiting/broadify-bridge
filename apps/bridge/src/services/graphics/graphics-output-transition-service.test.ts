import { setBridgeContext } from "../bridge-context.js";
import {
  GraphicsOutputTransitionService,
  GraphicsOutputTransitionError,
} from "./graphics-output-transition-service.js";

const baseConfig = {
  version: 1 as const,
  outputKey: "stub" as const,
  targets: {},
  format: { width: 1920, height: 1080, fps: 50 },
  range: "legal" as const,
  colorspace: "auto" as const,
};

const mockAdapter = {
  configure: jest.fn().mockResolvedValue(undefined),
  stop: jest.fn().mockResolvedValue(undefined),
  sendFrame: jest.fn().mockResolvedValue(undefined),
};

const mockRenderer = {
  configureSession: jest.fn().mockResolvedValue(undefined),
  initialize: jest.fn().mockResolvedValue(undefined),
  setAssets: jest.fn().mockResolvedValue(undefined),
  renderLayer: jest.fn().mockResolvedValue(undefined),
  updateValues: jest.fn().mockResolvedValue(undefined),
  updateLayout: jest.fn().mockResolvedValue(undefined),
  removeLayer: jest.fn().mockResolvedValue(undefined),
  onError: jest.fn(),
  shutdown: jest.fn().mockResolvedValue(undefined),
};

const mockFrameBusConfig = {
  name: "fb-1",
  slotCount: 2,
  pixelFormat: 1 as const,
  width: 1920,
  height: 1080,
  fps: 50,
  frameSize: 0,
  slotStride: 0,
  headerSize: 0,
  size: 0,
};

const mockRendererConfig = { width: 1920, height: 1080, fps: 50 };

describe("GraphicsOutputTransitionService", () => {
  let getRuntime: () => {
    outputConfig: typeof baseConfig | null;
    frameBusConfig: typeof mockFrameBusConfig | null;
    outputAdapter: typeof mockAdapter;
  };
  let setRuntime: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: {
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      },
    });
    const runtime = {
      outputConfig: null,
      frameBusConfig: null,
      outputAdapter: { ...mockAdapter },
    };
    getRuntime = () => runtime;
    setRuntime = jest.fn((r: typeof runtime) => {
      Object.assign(runtime, r);
    });
  });

  describe("GraphicsOutputTransitionError", () => {
    it("has stage and name", () => {
      const err = new GraphicsOutputTransitionError(
        "renderer_configure",
        "config failed"
      );
      expect(err.stage).toBe("renderer_configure");
      expect(err.message).toBe("config failed");
      expect(err.name).toBe("GraphicsOutputTransitionError");
    });
  });

  describe("waitForTransition", () => {
    it("resolves when no transition is running", async () => {
      const service = new GraphicsOutputTransitionService({
        getRenderer: () => mockRenderer as never,
        getRuntime,
        setRuntime,
        selectOutputAdapter: jest.fn().mockResolvedValue({ ...mockAdapter }),
        persistConfig: jest.fn().mockResolvedValue(undefined),
        clearPersistedConfig: jest.fn().mockResolvedValue(undefined),
        resolveFrameBusConfig: jest.fn().mockReturnValue(mockFrameBusConfig),
        buildRendererConfig: jest.fn().mockReturnValue(mockRendererConfig),
        logFrameBusConfigChange: jest.fn(),
      });

      await expect(service.waitForTransition()).resolves.toBeUndefined();
    });
  });

  describe("runAtomicTransition", () => {
    it("runs full transition and updates runtime", async () => {
      const selectOutputAdapter = jest.fn().mockResolvedValue({ ...mockAdapter });
      const persistConfig = jest.fn().mockResolvedValue(undefined);
      const resolveFrameBusConfig = jest.fn().mockReturnValue(mockFrameBusConfig);
      const buildRendererConfig = jest.fn().mockReturnValue(mockRendererConfig);
      const logFrameBusConfigChange = jest.fn();

      const service = new GraphicsOutputTransitionService({
        getRenderer: () => mockRenderer as never,
        getRuntime,
        setRuntime,
        selectOutputAdapter,
        persistConfig,
        clearPersistedConfig: jest.fn().mockResolvedValue(undefined),
        resolveFrameBusConfig,
        buildRendererConfig,
        logFrameBusConfigChange,
      });

      await service.runAtomicTransition(baseConfig);

      expect(selectOutputAdapter).toHaveBeenCalledWith(baseConfig);
      expect(mockRenderer.configureSession).toHaveBeenCalledWith(mockRendererConfig);
      expect(mockAdapter.stop).toHaveBeenCalled();
      expect(mockAdapter.configure).toHaveBeenCalledWith(baseConfig);
      expect(persistConfig).toHaveBeenCalledWith(baseConfig);
      expect(setRuntime).toHaveBeenCalledWith(
        expect.objectContaining({
          outputConfig: baseConfig,
          frameBusConfig: mockFrameBusConfig,
        })
      );
      expect(logFrameBusConfigChange).toHaveBeenCalled();
    });

    it("throws GraphicsOutputTransitionError with stage when a step fails", async () => {
      mockRenderer.configureSession.mockRejectedValueOnce(
        new Error("configure failed")
      );

      const service = new GraphicsOutputTransitionService({
        getRenderer: () => mockRenderer as never,
        getRuntime,
        setRuntime,
        selectOutputAdapter: jest.fn().mockResolvedValue({ ...mockAdapter }),
        persistConfig: jest.fn().mockResolvedValue(undefined),
        clearPersistedConfig: jest.fn().mockResolvedValue(undefined),
        resolveFrameBusConfig: jest.fn().mockReturnValue(mockFrameBusConfig),
        buildRendererConfig: jest.fn().mockReturnValue(mockRendererConfig),
        logFrameBusConfigChange: jest.fn(),
      });

      await expect(service.runAtomicTransition(baseConfig)).rejects.toMatchObject({
        name: "GraphicsOutputTransitionError",
        stage: "renderer_configure",
        message: expect.stringContaining("configure failed"),
      });
    });

    it("includes rollback_failed in message when rollback fails", async () => {
      const nextAdapterStopFails = {
        ...mockAdapter,
        stop: jest.fn().mockRejectedValue(new Error("stop failed")),
      };
      mockRenderer.configureSession.mockRejectedValueOnce(new Error("session fail"));

      const service = new GraphicsOutputTransitionService({
        getRenderer: () => mockRenderer as never,
        getRuntime,
        setRuntime,
        selectOutputAdapter: jest.fn().mockResolvedValue(nextAdapterStopFails),
        persistConfig: jest.fn().mockResolvedValue(undefined),
        clearPersistedConfig: jest.fn().mockResolvedValue(undefined),
        resolveFrameBusConfig: jest.fn().mockReturnValue(mockFrameBusConfig),
        buildRendererConfig: jest.fn().mockReturnValue(mockRendererConfig),
        logFrameBusConfigChange: jest.fn(),
      });

      await expect(service.runAtomicTransition(baseConfig)).rejects.toMatchObject({
        name: "GraphicsOutputTransitionError",
        message: expect.stringMatching(/rollback_failed|stop_next_adapter/),
      });
    });
  });
});
