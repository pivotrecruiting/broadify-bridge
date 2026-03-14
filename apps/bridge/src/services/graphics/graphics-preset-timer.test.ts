import {
  maybeStartPresetTimer,
  clearPresetTimer,
  setPresetDurationPending,
  clearPresetDuration,
} from "./graphics-preset-timer.js";

describe("graphics-preset-timer", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe("maybeStartPresetTimer", () => {
    it("returns false when preset has no pendingStart", () => {
      const preset = {
        presetId: "p1",
        durationMs: 5000,
        layerIds: new Set(["layer-1"]),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const onExpire = jest.fn();

      const result = maybeStartPresetTimer({
        preset,
        renderedLayerIds: ["layer-1"],
        onExpire,
      });

      expect(result).toBe(false);
      expect(onExpire).not.toHaveBeenCalled();
    });

    it("returns false when no rendered layer matches preset layerIds", () => {
      const preset = {
        presetId: "p1",
        durationMs: 5000,
        layerIds: new Set(["layer-1", "layer-2"]),
        pendingStart: true,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      const onExpire = jest.fn();

      const result = maybeStartPresetTimer({
        preset,
        renderedLayerIds: ["layer-3"],
        onExpire,
      });

      expect(result).toBe(false);
      expect(preset.startedAt).toBeNull();
    });

    it("starts timer and returns true when at least one layer rendered and pendingStart", () => {
      jest.useFakeTimers();
      const preset = {
        presetId: "p1",
        durationMs: 100,
        layerIds: new Set(["layer-1"]),
        pendingStart: true,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
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
      expect(preset.startedAt).toBe(now);
      expect(preset.expiresAt).toBe(now + 100);
      expect(preset.timer).not.toBeNull();

      jest.advanceTimersByTime(100);
      expect(onExpire).toHaveBeenCalledWith("p1");

      clearPresetTimer(preset);
    });
  });

  describe("clearPresetTimer", () => {
    it("clears timer when preset has timer set", () => {
      jest.useFakeTimers();
      const preset = {
        presetId: "p1",
        durationMs: 1000,
        layerIds: new Set(),
        pendingStart: true,
        startedAt: null,
        expiresAt: null,
        timer: setTimeout(() => {}, 1000) as NodeJS.Timeout,
      };

      clearPresetTimer(preset);

      expect(preset.timer).toBeNull();
    });

    it("no-op when preset is null or has no timer", () => {
      const preset = {
        presetId: "p1",
        durationMs: null,
        layerIds: new Set(),
        pendingStart: false,
        startedAt: null,
        expiresAt: null,
        timer: null,
      };
      clearPresetTimer(preset);
      clearPresetTimer(null);
      expect(preset.timer).toBeNull();
    });
  });

  describe("setPresetDurationPending", () => {
    it("sets duration, clears timer, and marks pendingStart", () => {
      jest.useFakeTimers();
      const preset = {
        presetId: "p1",
        durationMs: 5000,
        layerIds: new Set(),
        pendingStart: false,
        startedAt: 1000,
        expiresAt: 6000,
        timer: setTimeout(() => {}, 5000) as NodeJS.Timeout,
      };

      setPresetDurationPending(preset, 3000);

      expect(preset.durationMs).toBe(3000);
      expect(preset.pendingStart).toBe(true);
      expect(preset.startedAt).toBeNull();
      expect(preset.expiresAt).toBeNull();
      expect(preset.timer).toBeNull();
    });
  });

  describe("clearPresetDuration", () => {
    it("clears timer and duration state", () => {
      jest.useFakeTimers();
      const preset = {
        presetId: "p1",
        durationMs: 5000,
        layerIds: new Set(),
        pendingStart: true,
        startedAt: null,
        expiresAt: null,
        timer: setTimeout(() => {}, 5000) as NodeJS.Timeout,
      };

      clearPresetDuration(preset);

      expect(preset.durationMs).toBeNull();
      expect(preset.pendingStart).toBe(false);
      expect(preset.startedAt).toBeNull();
      expect(preset.expiresAt).toBeNull();
      expect(preset.timer).toBeNull();
    });
  });
});
