import { setBridgeContext } from "../bridge-context.js";
import { GraphicsPresetService } from "./graphics-preset-service.js";
import type { GraphicsActivePresetT, GraphicsLayerStateT } from "./graphics-manager-types.js";

const mockRemoveLayerWithRenderer = jest.fn().mockResolvedValue(undefined);
jest.mock("./graphics-layer-service.js", () => ({
  removeLayerWithRenderer: (...args: unknown[]) =>
    mockRemoveLayerWithRenderer(...args),
}));

const mockClearPresetTimer = jest.fn();
const mockMaybeStartPresetTimer = jest.fn().mockReturnValue(false);
const mockSetPresetDurationPending = jest.fn();
const mockClearPresetDuration = jest.fn();

jest.mock("./graphics-preset-timer.js", () => ({
  clearPresetTimer: (...args: unknown[]) => mockClearPresetTimer(...args),
  maybeStartPresetTimer: (...args: unknown[]) =>
    mockMaybeStartPresetTimer(...args),
  setPresetDurationPending: (...args: unknown[]) =>
    mockSetPresetDurationPending(...args),
  clearPresetDuration: (...args: unknown[]) => mockClearPresetDuration(...args),
}));

function createMockRenderer() {
  return {
    removeLayer: jest.fn().mockResolvedValue(undefined),
    renderLayer: jest.fn(),
    initialize: jest.fn(),
    configureSession: jest.fn(),
    setAssets: jest.fn(),
    updateValues: jest.fn(),
    updateLayout: jest.fn(),
    onError: jest.fn(),
    shutdown: jest.fn(),
  };
}

function createLayerState(overrides: Partial<GraphicsLayerStateT> = {}): GraphicsLayerStateT {
  return {
    layerId: "layer-1",
    category: "lower_third",
    layout: "fill",
    zIndex: 1,
    backgroundMode: "opaque",
    values: {},
    bindings: {},
    schema: {},
    defaults: {},
    ...overrides,
  };
}

describe("GraphicsPresetService", () => {
  let layers: Map<string, GraphicsLayerStateT>;
  let categoryToLayer: Map<string, string>;
  let activePreset: GraphicsActivePresetT | null;
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
    layers = new Map();
    categoryToLayer = new Map();
    activePreset = null;
  });

  function createService() {
    return new GraphicsPresetService({
      getRenderer: () => createMockRenderer() as never,
      layers,
      categoryToLayer,
      getActivePreset: () => activePreset,
      setActivePreset: (p) => {
        activePreset = p;
      },
      publishStatus: jest.fn(),
    });
  }

  describe("prepareBeforeRender", () => {
    it("removes layers not in preset when presetId provided", async () => {
      layers.set(
        "old-layer",
        createLayerState({ layerId: "old-layer", presetId: "other-preset" })
      );
      categoryToLayer.set("fullscreen", "old-layer");
      const service = createService();

      await service.prepareBeforeRender("new-preset", "lower_third");

      expect(mockRemoveLayerWithRenderer).toHaveBeenCalledWith(
        expect.anything(),
        "old-layer",
        "preset_replace"
      );
    });

    it("when no presetId and activePreset exists, removes active preset", async () => {
      activePreset = {
        presetId: "p1",
        durationMs: 5000,
        layerIds: new Set(["layer-1"]),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      layers.set("layer-1", createLayerState({ layerId: "layer-1", presetId: "p1" }));
      const service = createService();

      await service.prepareBeforeRender(undefined, "lower_third");

      expect(mockRemoveLayerWithRenderer).toHaveBeenCalled();
    });
  });

  describe("syncAfterRender", () => {
    it("does nothing when presetId is undefined", () => {
      const service = createService();

      service.syncAfterRender("layer-1", undefined, null);

      expect(activePreset).toBeNull();
    });

    it("creates new active preset when presetId provided and none active", () => {
      const publishStatus = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset: (p) => {
          activePreset = p;
        },
        publishStatus,
      });

      service.syncAfterRender("layer-1", "preset-a", 5000);

      expect(activePreset).not.toBeNull();
      expect(activePreset!.presetId).toBe("preset-a");
      expect(activePreset!.layerIds.has("layer-1")).toBe(true);
      expect(activePreset!.durationMs).toBe(5000);
      expect(activePreset!.pendingStart).toBe(true);
      expect(publishStatus).toHaveBeenCalledWith("preset_update");
    });

    it("adds layer to existing preset when same presetId", () => {
      activePreset = {
        presetId: "preset-a",
        durationMs: null,
        layerIds: new Set(["layer-1"]),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const publishStatus = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset: (p) => {
          activePreset = p;
        },
        publishStatus,
      });

      service.syncAfterRender("layer-2", "preset-a", null);

      expect(activePreset!.layerIds.has("layer-2")).toBe(true);
      expect(publishStatus).toHaveBeenCalledWith("preset_update");
    });
  });

  describe("maybeStartPresetTimers", () => {
    it("does nothing when no active preset", () => {
      const publishStatus = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => null,
        setActivePreset: jest.fn(),
        publishStatus,
      });

      service.maybeStartPresetTimers(["layer-1"]);

      expect(mockMaybeStartPresetTimer).not.toHaveBeenCalled();
      expect(publishStatus).not.toHaveBeenCalled();
    });

    it("calls maybeStartPresetTimer and publishStatus when timer started", () => {
      activePreset = {
        presetId: "p1",
        durationMs: 1000,
        layerIds: new Set(["layer-1"]),
        pendingStart: true,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      mockMaybeStartPresetTimer.mockReturnValueOnce(true);
      const publishStatus = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset: jest.fn(),
        publishStatus,
      });

      service.maybeStartPresetTimers(["layer-1"]);

      expect(mockMaybeStartPresetTimer).toHaveBeenCalled();
      expect(publishStatus).toHaveBeenCalledWith("preset_started");
    });
  });

  describe("clearActivePreset", () => {
    it("clears timer and sets active preset to null", () => {
      activePreset = {
        presetId: "p1",
        durationMs: null,
        layerIds: new Set(),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const setActivePreset = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset,
        publishStatus: jest.fn(),
      });

      service.clearActivePreset();

      expect(mockClearPresetTimer).toHaveBeenCalledWith(activePreset);
      expect(setActivePreset).toHaveBeenCalledWith(null);
    });
  });

  describe("handleLayerRemoved", () => {
    it("does nothing when layer has no presetId or different preset", () => {
      activePreset = {
        presetId: "p1",
        durationMs: null,
        layerIds: new Set(["layer-1"]),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const publishStatus = jest.fn();
      const setActivePreset = jest.fn((p) => {
        activePreset = p;
      });
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset,
        publishStatus,
      });

      service.handleLayerRemoved(createLayerState({ layerId: "other", presetId: "other-preset" }));

      expect(activePreset!.layerIds.size).toBe(1);
      expect(publishStatus).not.toHaveBeenCalled();
    });

    it("clears preset when last layer of preset is removed", () => {
      activePreset = {
        presetId: "p1",
        durationMs: null,
        layerIds: new Set(["layer-1"]),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const publishStatus = jest.fn();
      const setActivePreset = jest.fn((p) => {
        activePreset = p;
      });
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => activePreset,
        setActivePreset,
        publishStatus,
      });

      service.handleLayerRemoved(createLayerState({ layerId: "layer-1", presetId: "p1" }));

      expect(setActivePreset).toHaveBeenCalledWith(null);
      expect(publishStatus).toHaveBeenCalledWith("preset_cleared");
    });
  });

  describe("removePresetById", () => {
    it("removes layers with matching presetId and publishes status", async () => {
      layers.set("layer-1", createLayerState({ layerId: "layer-1", presetId: "p1" }));
      layers.set("layer-2", createLayerState({ layerId: "layer-2", presetId: "p1" }));
      const publishStatus = jest.fn();
      const service = new GraphicsPresetService({
        getRenderer: () => createMockRenderer() as never,
        layers,
        categoryToLayer,
        getActivePreset: () => null,
        setActivePreset: jest.fn(),
        publishStatus,
      });

      await service.removePresetById("p1");

      expect(mockRemoveLayerWithRenderer).toHaveBeenCalledTimes(2);
      expect(publishStatus).toHaveBeenCalledWith("preset_removed");
    });
  });
});
