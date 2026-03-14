import { setBridgeContext } from "../bridge-context.js";
import {
  removeLayerWithRenderer,
  validateLayerLimits,
  renderPreparedLayer,
  clearAllLayers,
} from "./graphics-layer-service.js";
import type { GraphicsLayerStateT, PreparedLayerT } from "./graphics-manager-types.js";

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

function createMockRenderer() {
  return {
    removeLayer: jest.fn().mockResolvedValue(undefined),
    renderLayer: jest.fn().mockResolvedValue(undefined),
    initialize: jest.fn().mockResolvedValue(undefined),
    configureSession: jest.fn().mockResolvedValue(undefined),
    setAssets: jest.fn().mockResolvedValue(undefined),
    updateValues: jest.fn().mockResolvedValue(undefined),
    updateLayout: jest.fn().mockResolvedValue(undefined),
    onError: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  };
}

function createPreparedLayer(overrides: Partial<PreparedLayerT> = {}): PreparedLayerT {
  return {
    layerId: "layer-1",
    category: "lower_third",
    backgroundMode: "opaque",
    layout: "fill",
    zIndex: 1,
    values: {},
    bindings: {},
    bundle: {
      html: "<div></div>",
      css: "",
      schema: {},
      defaults: {},
    },
    ...overrides,
  };
}

describe("graphics-layer-service", () => {
  beforeEach(() => {
    setBridgeContext({
      userDataDir: "/tmp",
      logPath: "/tmp/bridge.log",
      logger: mockLogger,
    });
    jest.clearAllMocks();
  });

  describe("removeLayerWithRenderer", () => {
    it("removes layer from renderer and state", async () => {
      const renderer = createMockRenderer();
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      const layer: GraphicsLayerStateT = {
        layerId: "l1",
        category: "lower_third",
        layout: "fill",
        zIndex: 1,
        backgroundMode: "opaque",
        values: {},
        bindings: {},
        schema: {},
        defaults: {},
      };
      layers.set("l1", layer);
      categoryToLayer.set("lower_third", "l1");

      await removeLayerWithRenderer(
        { renderer, layers, categoryToLayer },
        "l1",
        "manual"
      );

      expect(renderer.removeLayer).toHaveBeenCalledWith("l1");
      expect(layers.has("l1")).toBe(false);
      expect(categoryToLayer.has("lower_third")).toBe(false);
    });

    it("removes category mapping only when layer was the one registered for that category", async () => {
      const renderer = createMockRenderer();
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      categoryToLayer.set("lower_third", "other-id");
      layers.set("l1", {
        layerId: "l1",
        category: "fullscreen",
        layout: "fill",
        zIndex: 0,
        backgroundMode: "opaque",
        values: {},
        bindings: {},
        schema: {},
        defaults: {},
      });

      await removeLayerWithRenderer(
        { renderer, layers, categoryToLayer },
        "l1",
        "clear"
      );

      expect(categoryToLayer.get("lower_third")).toBe("other-id");
    });

    it("logs warn when renderer.removeLayer throws", async () => {
      const renderer = createMockRenderer();
      renderer.removeLayer.mockRejectedValue(new Error("Renderer busy"));
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();

      await removeLayerWithRenderer(
        { renderer, layers, categoryToLayer },
        "l1",
        "clear"
      );

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to remove layer l1")
      );
      expect(layers.has("l1")).toBe(false);
    });
  });

  describe("validateLayerLimits", () => {
    it("throws when another layer already has the category", () => {
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      categoryToLayer.set("lower_third", "other-layer");
      layers.set("other-layer", {} as GraphicsLayerStateT);

      expect(() =>
        validateLayerLimits(layers, categoryToLayer, "new-layer", "lower_third")
      ).toThrow("Layer already active for category lower_third");
    });

    it("allows same layerId for same category (update)", () => {
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      categoryToLayer.set("lower_third", "layer-1");
      layers.set("layer-1", {} as GraphicsLayerStateT);

      expect(() =>
        validateLayerLimits(layers, categoryToLayer, "layer-1", "lower_third")
      ).not.toThrow();
    });

    it("throws when max active layers reached and layer is new", () => {
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      for (let i = 0; i < 3; i++) {
        layers.set(`layer-${i}`, {} as GraphicsLayerStateT);
      }

      expect(() =>
        validateLayerLimits(layers, categoryToLayer, "layer-new", "fullscreen")
      ).toThrow("Maximum active layers reached");
    });

    it("allows when under limit", () => {
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      layers.set("layer-1", {} as GraphicsLayerStateT);

      expect(() =>
        validateLayerLimits(layers, categoryToLayer, "layer-2", "lower_third")
      ).not.toThrow();
    });
  });

  describe("renderPreparedLayer", () => {
    it("stores layer state, calls renderer.renderLayer, and invokes onRendered", async () => {
      const renderer = createMockRenderer();
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      const onRendered = jest.fn();
      const data = createPreparedLayer({
        layerId: "l1",
        category: "lower_third",
        values: { title: "Hi" },
        bindings: { title: "Hi" },
      });

      await renderPreparedLayer({
        renderer,
        layers,
        categoryToLayer,
        outputFormat: { width: 1920, height: 1080, fps: 50 },
        data,
        onRendered,
      });

      expect(layers.get("l1")).toBeDefined();
      expect(layers.get("l1")!.values).toEqual({ title: "Hi" });
      expect(categoryToLayer.get("lower_third")).toBe("l1");
      expect(renderer.renderLayer).toHaveBeenCalledWith(
        expect.objectContaining({
          layerId: "l1",
          width: 1920,
          height: 1080,
          fps: 50,
        })
      );
      expect(onRendered).toHaveBeenCalledWith(["l1"]);
    });

    it("uses default format when outputFormat is null", async () => {
      const renderer = createMockRenderer();
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      const onRendered = jest.fn();

      await renderPreparedLayer({
        renderer,
        layers,
        categoryToLayer,
        outputFormat: null,
        data: createPreparedLayer({ layerId: "l1" }),
        onRendered,
      });

      expect(renderer.renderLayer).toHaveBeenCalledWith(
        expect.objectContaining({ width: 1920, height: 1080, fps: 50 })
      );
    });

    it("rolls back state when renderer.renderLayer throws", async () => {
      const renderer = createMockRenderer();
      renderer.renderLayer.mockRejectedValue(new Error("Render failed"));
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      const onRendered = jest.fn();
      const data = createPreparedLayer({ layerId: "l1", category: "lower_third" });

      await expect(
        renderPreparedLayer({
          renderer,
          layers,
          categoryToLayer,
          outputFormat: null,
          data,
          onRendered,
        })
      ).rejects.toThrow("Render failed");

      expect(layers.has("l1")).toBe(false);
      expect(categoryToLayer.has("lower_third")).toBe(false);
      expect(onRendered).not.toHaveBeenCalled();
    });
  });

  describe("clearAllLayers", () => {
    it("removes all layers, clears active preset, and publishes status", async () => {
      const renderer = createMockRenderer();
      const layers = new Map<string, GraphicsLayerStateT>();
      const categoryToLayer = new Map<string, string>();
      layers.set("l1", {
        layerId: "l1",
        category: "lower_third",
        layout: "fill",
        zIndex: 1,
        backgroundMode: "opaque",
        values: {},
        bindings: {},
        schema: {},
        defaults: {},
      });
      categoryToLayer.set("lower_third", "l1");
      const clearActivePreset = jest.fn();
      const publishStatus = jest.fn();

      await clearAllLayers({
        renderer,
        layers,
        categoryToLayer,
        clearActivePreset,
        publishStatus,
      });

      expect(renderer.removeLayer).toHaveBeenCalledWith("l1");
      expect(layers.size).toBe(0);
      expect(clearActivePreset).toHaveBeenCalled();
      expect(publishStatus).toHaveBeenCalledWith("clear_all_layers");
    });
  });
});
