import type { GraphicsActivePresetT } from "./graphics-manager-types.js";

type StartPresetTimerParamsT = {
  preset: GraphicsActivePresetT;
  renderedLayerIds: string[];
  onExpire: (presetId: string) => void;
  now?: () => number;
};

/**
 * Start a pending preset timer when at least one required layer has rendered.
 *
 * @param params Start parameters.
 * @returns True when timer was started.
 */
export function maybeStartPresetTimer(params: StartPresetTimerParamsT): boolean {
  if (!params.preset.pendingStart) {
    return false;
  }

  const hasActiveLayer = params.renderedLayerIds.some((layerId) =>
    params.preset.layerIds.has(layerId)
  );
  if (!hasActiveLayer) {
    return false;
  }

  const now = params.now ? params.now() : Date.now();
  const presetId = params.preset.presetId;
  const durationMs = params.preset.durationMs ?? 0;
  params.preset.pendingStart = false;
  params.preset.startedAt = now;
  params.preset.expiresAt = now + durationMs;
  params.preset.timer = setTimeout(() => {
    params.onExpire(presetId);
  }, durationMs);
  return true;
}

/**
 * Clear active timer handle of a preset.
 *
 * @param preset Active preset.
 */
export function clearPresetTimer(preset: GraphicsActivePresetT | null): void {
  if (preset?.timer) {
    clearTimeout(preset.timer);
    preset.timer = null;
  }
}

/**
 * Set a new duration and mark timer start as pending.
 *
 * @param preset Active preset.
 * @param durationMs Duration in milliseconds.
 */
export function setPresetDurationPending(
  preset: GraphicsActivePresetT,
  durationMs: number
): void {
  clearPresetTimer(preset);
  preset.durationMs = durationMs;
  preset.pendingStart = true;
  preset.startedAt = null;
  preset.expiresAt = null;
}

/**
 * Disable timed expiration for a preset.
 *
 * @param preset Active preset.
 */
export function clearPresetDuration(preset: GraphicsActivePresetT): void {
  clearPresetTimer(preset);
  preset.durationMs = null;
  preset.pendingStart = false;
  preset.startedAt = null;
  preset.expiresAt = null;
}
