import {
  maybeStartPresetTimer,
  clearPresetTimer,
  setPresetDurationPending,
  clearPresetDuration,
} from "./graphics-preset-timer.js";
import type { GraphicsActivePresetT } from "./graphics-manager-types.js";

function createPreset(overrides: Partial<GraphicsActivePresetT> = {}): GraphicsActivePresetT {
  return {
    presetId: "preset-1",
    durationMs: 1000,
    layerIds: new Set(["layer-1", "layer-2"]),
    pendingStart: false,
    startedAt: null,
    expiresAt: null,
    timer: null,
    ...overrides,
  };
}

describe("graphics-preset-timer", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("maybeStartPresetTimer", () => {
    it("returns false when preset has no pendingStart", () => {
      const preset = createPreset({ pendingStart: false });
      const onExpire = jest.fn();

      const result = maybeStartPresetTimer({
        preset,
        renderedLayerIds: ["layer-1"],
        onExpire,
      });

      expect(result).toBe(false);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("returns false when no required layer has rendered", () => {
      const preset = createPreset({ pendingStart: true });
      const onExpire = jest.fn();

      const result = maybeStartPresetTimer({
        preset,
        renderedLayerIds: ["other-layer"],
        onExpire,
      });

      expect(result).toBe(false);
      expect(preset.timer).toBeNull();
    });

    it("starts timer and returns true when at least one layer rendered", () => {
      const preset = createPreset({
        pendingStart: true,
        durationMs: 500,
      });
      const onExpire = jest.fn();
      const now = 1000;

      const result = maybeStartPresetTimer({
        preset,
        renderedLayerIds: ["layer-1"],
        onExpire,
        now: () => now,
      });

      expect(result).toBe(true);
      expect(preset.pendingStart).toBe(false);
      expect(preset.startedAt).toBe(1000);
      expect(preset.expiresAt).toBe(1500);
      expect(preset.timer).toBeDefined();

      jest.advanceTimersByTime(500);
      expect(onExpire).toHaveBeenCalledWith("preset-1");
    });
  });

  describe("clearPresetTimer", () => {
    it("clears timer when preset has one", () => {
      const preset = createPreset();
      preset.timer = setTimeout(() => {}, 1000);

      clearPresetTimer(preset);

      expect(preset.timer).toBeNull();
    });

    it("no-op when preset is null", () => {
      expect(() => clearPresetTimer(null)).not.toThrow();
    });

    it("no-op when preset has no timer", () => {
      const preset = createPreset({ timer: null });
      expect(() => clearPresetTimer(preset)).not.toThrow();
    });
  });

  describe("setPresetDurationPending", () => {
    it("clears existing timer and sets pending duration", () => {
      const preset = createPreset({ timer: setTimeout(() => {}, 1000) });

      setPresetDurationPending(preset, 2000);

      expect(preset.timer).toBeNull();
      expect(preset.durationMs).toBe(2000);
      expect(preset.pendingStart).toBe(true);
      expect(preset.startedAt).toBeNull();
      expect(preset.expiresAt).toBeNull();
    });
  });

  describe("clearPresetDuration", () => {
    it("clears timer and resets duration state", () => {
      const preset = createPreset({
        durationMs: 1000,
        pendingStart: true,
        timer: setTimeout(() => {}, 1000),
      });

      clearPresetDuration(preset);

      expect(preset.timer).toBeNull();
      expect(preset.durationMs).toBeNull();
      expect(preset.pendingStart).toBe(false);
      expect(preset.startedAt).toBeNull();
      expect(preset.expiresAt).toBeNull();
    });
  });
});
