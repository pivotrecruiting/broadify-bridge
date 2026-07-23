import {
  AudioDirectorConfig,
  DEFAULT_AUDIO_DIRECTOR_CONFIG,
  DirectionReading,
  DirectorZone,
} from "./types.js";

/**
 * Brand-agnostic decision engine for the conference auto-director.
 *
 * Given a stream of normalized {@link DirectionReading}s and the camera that is
 * currently on program, it decides when to cut to a different camera. The logic
 * mirrors what professional systems (Q-SYS ACPR, AVer PTZ Link) do:
 *
 *  - A challenger camera must be the talker's zone continuously for
 *    `switchDelayMs` before the cut commits (dwell → ignores brief interjections).
 *  - After any cut the program is held for at least `minHoldMs` (anti-flicker).
 *  - Angular hysteresis at zone edges: once a zone is on program, the talker
 *    must move `boundaryHysteresisDeg` past its edge before the zone is left,
 *    so a speaker sitting on a boundary does not oscillate the shot.
 *  - Silence longer than `silenceToWideMs`, or two+ simultaneous talkers longer
 *    than `multiTalkerToWideMs`, falls back to the wide/group camera instead of
 *    ping-ponging.
 *
 * Pure and deterministic: every decision is a function of the readings and an
 * injected `nowMs` clock, so it is fully unit-testable without timers.
 */
export class AudioDirector {
  private config: AudioDirectorConfig;

  // Challenger tracking (a single-talker zone competing for program).
  private candidateCamera: number | null = null;
  private candidateSinceMs = 0;

  // Wide-fallback tracking.
  private silenceSinceMs: number | null = null;
  private multiTalkerSinceMs: number | null = null;

  // Anti-flicker: timestamp of the last committed cut.
  private lastSwitchMs = Number.NEGATIVE_INFINITY;

  constructor(config?: Partial<AudioDirectorConfig>) {
    this.config = { ...DEFAULT_AUDIO_DIRECTOR_CONFIG, ...config };
  }

  /** Replaces the tunables/zones; clears any in-progress challenger. */
  setConfig(config: Partial<AudioDirectorConfig>): void {
    this.config = { ...this.config, ...config };
    this.candidateCamera = null;
  }

  getConfig(): AudioDirectorConfig {
    return this.config;
  }

  /** Forgets in-progress challengers/timers (e.g. director toggled off/on). */
  reset(): void {
    this.candidateCamera = null;
    this.silenceSinceMs = null;
    this.multiTalkerSinceMs = null;
    this.lastSwitchMs = Number.NEGATIVE_INFINITY;
  }

  /**
   * Evaluates one reading against the current program camera.
   *
   * @returns the camera index to cut to, or null to hold the current program.
   */
  evaluate(
    reading: DirectionReading,
    currentCamera: number,
    nowMs: number,
  ): number | null {
    const target = this.classify(reading, currentCamera);

    // Maintain the wide-fallback timers from the reading category.
    if (target.kind === "multi") {
      this.candidateCamera = null;
      if (this.multiTalkerSinceMs === null) this.multiTalkerSinceMs = nowMs;
      this.silenceSinceMs = null;
      return this.considerWide(currentCamera, nowMs, this.multiTalkerSinceMs, this.config.multiTalkerToWideMs);
    }
    this.multiTalkerSinceMs = null;

    if (target.kind === "none") {
      // Nobody clearly speaking inside a zone (silence or outside coverage).
      this.candidateCamera = null;
      if (this.silenceSinceMs === null) this.silenceSinceMs = nowMs;
      return this.considerWide(currentCamera, nowMs, this.silenceSinceMs, this.config.silenceToWideMs);
    }

    // A single talker inside a concrete zone.
    this.silenceSinceMs = null;
    const zoneCamera = target.cameraIndex;

    if (zoneCamera === currentCamera) {
      // Already on the right camera — nothing to do.
      this.candidateCamera = null;
      return null;
    }

    // Challenger: must respect the minimum hold, then win the dwell window.
    if (nowMs - this.lastSwitchMs < this.config.minHoldMs) {
      return null;
    }
    if (this.candidateCamera !== zoneCamera) {
      this.candidateCamera = zoneCamera;
      this.candidateSinceMs = nowMs;
      return null;
    }
    if (nowMs - this.candidateSinceMs < this.config.switchDelayMs) {
      return null;
    }
    this.commitSwitch(nowMs);
    return zoneCamera;
  }

  /** Applies the wide/group fallback once its timer elapses. */
  private considerWide(
    currentCamera: number,
    nowMs: number,
    sinceMs: number,
    thresholdMs: number,
  ): number | null {
    const wide = this.config.wideCameraIndex;
    if (wide === null || currentCamera === wide) {
      return null;
    }
    if (nowMs - this.lastSwitchMs < this.config.minHoldMs) {
      return null;
    }
    if (nowMs - sinceMs < thresholdMs) {
      return null;
    }
    this.commitSwitch(nowMs);
    return wide;
  }

  private commitSwitch(nowMs: number): void {
    this.lastSwitchMs = nowMs;
    this.candidateCamera = null;
  }

  /**
   * Reduces a reading to what the director cares about: a concrete camera
   * (single talker in a zone), "multi" (crosstalk), or "none" (silence or a
   * talker outside every zone).
   */
  private classify(
    reading: DirectionReading,
    currentCamera: number,
  ):
    | { kind: "camera"; cameraIndex: number }
    | { kind: "multi" }
    | { kind: "none" } {
    if (reading.talkerCount >= 2) {
      return { kind: "multi" };
    }
    if (!reading.active || reading.azimuthDeg === null) {
      return { kind: "none" };
    }
    const camera = this.zoneCameraFor(reading.azimuthDeg, currentCamera);
    return camera === null
      ? { kind: "none" }
      : { kind: "camera", cameraIndex: camera };
  }

  /**
   * Finds the camera whose zone contains the angle, with edge hysteresis: if
   * the current camera's zone (widened by `boundaryHysteresisDeg`) still holds
   * the angle, it stays — a talker must clear the edge by the margin to switch.
   */
  private zoneCameraFor(azimuthDeg: number, currentCamera: number): number | null {
    const az = normalizeDeg(azimuthDeg);
    const margin = this.config.boundaryHysteresisDeg;

    const currentZone = this.config.zones.find(
      (z) => z.cameraIndex === currentCamera,
    );
    if (currentZone && arcContains(currentZone, az, margin)) {
      return currentCamera;
    }
    const match = this.config.zones.find((z) => arcContains(z, az, 0));
    return match ? match.cameraIndex : null;
  }
}

/** Normalizes any angle to [0,360). */
function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * True when `az` lies on the arc from zone.startDeg clockwise to zone.endDeg,
 * optionally widened by `margin` degrees on both edges. Handles the wrap past
 * 360°. A zero-width (degenerate) zone never contains anything.
 */
function arcContains(zone: DirectorZone, az: number, margin: number): boolean {
  const start = normalizeDeg(zone.startDeg);
  const width = normalizeDeg(zone.endDeg - zone.startDeg); // 0..360
  if (width === 0) {
    return false;
  }
  const widened = Math.min(360, width + 2 * margin);
  const offset = normalizeDeg(az - (start - margin));
  return offset < widened;
}
