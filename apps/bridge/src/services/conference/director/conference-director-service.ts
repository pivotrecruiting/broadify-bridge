import { AudioDirector } from "./audio-director.js";
import { MockDirectionSource } from "./mock-direction-source.js";
import { ShureDirectionSource } from "./shure-direction-source.js";
import { SennheiserTcc2Source } from "./sennheiser-tcc2-source.js";
import {
  AudioDirectorConfig,
  DEFAULT_AUDIO_DIRECTOR_CONFIG,
  DirectionReading,
  DirectionSource,
  DirectorZone,
} from "./types.js";

export type DirectorSourceKind = "mock" | "shure" | "sennheiser_tcc2";

export type ConferenceDirectorConfig = AudioDirectorConfig & {
  /** Which microphone-array protocol to read the talker direction from. */
  source: DirectorSourceKind;
  /** Array IP (Shure Control IP / Sennheiser device IP). Unused for "mock". */
  host: string | null;
  /** Optional protocol port override (defaults per source). */
  port: number | null;
  /** Rotation so azimuth 0° matches the room reference. */
  azimuthOffsetDeg: number;
};

export const DEFAULT_CONFERENCE_DIRECTOR_CONFIG: ConferenceDirectorConfig = {
  ...DEFAULT_AUDIO_DIRECTOR_CONFIG,
  source: "mock",
  host: null,
  port: null,
  azimuthOffsetDeg: 0,
};

/** Callback that actually cuts the program feed to a camera (seamless). */
export type ProgramSwitcher = (cameraIndex: number) => Promise<void> | void;

const TICK_INTERVAL_MS = 500;

/**
 * Orchestrates the conference auto-director: a {@link DirectionSource} (Shure /
 * Sennheiser / mock) feeds normalized readings into the {@link AudioDirector},
 * whose cut decisions are executed via the injected {@link ProgramSwitcher}
 * (the meeting helper's seamless `camera.program_select`).
 *
 * A low-frequency tick re-evaluates the last reading so the silence→wide and
 * crosstalk→wide fallbacks still fire if the array stops emitting entirely.
 */
export class ConferenceDirectorService {
  private config: ConferenceDirectorConfig = {
    ...DEFAULT_CONFERENCE_DIRECTOR_CONFIG,
  };
  private director = new AudioDirector(DEFAULT_CONFERENCE_DIRECTOR_CONFIG);
  private source: DirectionSource | null = null;
  private switcher: ProgramSwitcher | null = null;

  private running = false;
  private currentCamera = -1;
  private lastReading: DirectionReading | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;

  /** Provides the actuator; call once at wiring time. */
  setSwitcher(switcher: ProgramSwitcher): void {
    this.switcher = switcher;
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Merges a partial config; applies live to the director if running. */
  configure(patch: Partial<ConferenceDirectorConfig>): ConferenceDirectorConfig {
    this.config = { ...this.config, ...patch };
    this.director.setConfig(this.toDirectorConfig());
    return this.config;
  }

  /**
   * Starts the director against the configured array. `initialCamera` seeds the
   * "current program" so the first decision compares against the live shot.
   */
  async start(initialCamera: number): Promise<void> {
    if (this.running) {
      await this.stop();
    }
    this.currentCamera = initialCamera;
    this.director.setConfig(this.toDirectorConfig());
    this.director.reset();
    this.lastReading = null;
    this.lastError = null;

    this.source = this.createSource();
    this.source.onReading((reading) => this.onReading(reading));
    try {
      await this.source.start();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
    this.running = true;
    this.tickTimer = setInterval(() => this.onTick(), TICK_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.source) {
      await this.source.stop();
      this.source = null;
    }
    this.director.reset();
  }

  /** Records a manual cut so the director compares against the true program. */
  setCurrentCamera(cameraIndex: number): void {
    this.currentCamera = cameraIndex;
  }

  /** Feeds a synthetic reading (only meaningful when source === "mock"). */
  inject(reading: DirectionReading): void {
    if (this.source instanceof MockDirectionSource) {
      this.source.inject(reading);
    }
  }

  status(): Record<string, unknown> {
    return {
      running: this.running,
      source: this.config.source,
      host: this.config.host,
      connected: this.source?.isConnected() ?? false,
      current_camera: this.currentCamera,
      wide_camera_index: this.config.wideCameraIndex,
      zone_count: this.config.zones.length,
      last_azimuth: this.lastReading?.azimuthDeg ?? null,
      active: this.lastReading?.active ?? false,
      last_error: this.source?.lastError() ?? this.lastError,
    };
  }

  private onReading(reading: DirectionReading): void {
    this.lastReading = reading;
    this.decide(reading);
  }

  private onTick(): void {
    if (this.lastReading) {
      this.decide(this.lastReading);
    }
  }

  private decide(reading: DirectionReading): void {
    if (!this.running) {
      return;
    }
    const next = this.director.evaluate(reading, this.currentCamera, Date.now());
    if (next !== null && next !== this.currentCamera) {
      void this.applySwitch(next);
    }
  }

  private async applySwitch(cameraIndex: number): Promise<void> {
    try {
      await this.switcher?.(cameraIndex);
      // Only adopt the new shot once the cut actually landed; if the switcher
      // throws (helper down, etc.) currentCamera must not diverge from program.
      this.currentCamera = cameraIndex;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private createSource(): DirectionSource {
    const host = this.config.host ?? "";
    const port = this.config.port ?? undefined;
    switch (this.config.source) {
      case "shure":
        return new ShureDirectionSource({
          host,
          port,
          azimuthOffsetDeg: this.config.azimuthOffsetDeg,
        });
      case "sennheiser_tcc2":
        return new SennheiserTcc2Source({
          host,
          port,
          azimuthOffsetDeg: this.config.azimuthOffsetDeg,
        });
      case "mock":
      default:
        return new MockDirectionSource();
    }
  }

  private toDirectorConfig(): AudioDirectorConfig {
    return {
      zones: this.config.zones,
      wideCameraIndex: this.config.wideCameraIndex,
      switchDelayMs: this.config.switchDelayMs,
      minHoldMs: this.config.minHoldMs,
      silenceToWideMs: this.config.silenceToWideMs,
      multiTalkerToWideMs: this.config.multiTalkerToWideMs,
      boundaryHysteresisDeg: this.config.boundaryHysteresisDeg,
    };
  }
}

/** Parses a loosely-typed relay payload into a director config patch. */
export function parseDirectorConfigPatch(
  payload: Record<string, unknown>,
): Partial<ConferenceDirectorConfig> {
  const patch: Partial<ConferenceDirectorConfig> = {};
  const source = payload.source;
  if (source === "mock" || source === "shure" || source === "sennheiser_tcc2") {
    patch.source = source;
  }
  if (typeof payload.host === "string") patch.host = payload.host;
  if (payload.host === null) patch.host = null;
  if (typeof payload.port === "number") patch.port = payload.port;
  if (payload.port === null) patch.port = null;
  if (isFiniteNumber(payload.azimuth_offset_deg)) {
    patch.azimuthOffsetDeg = payload.azimuth_offset_deg;
  }
  if (isFiniteNumber(payload.wide_camera_index)) {
    patch.wideCameraIndex = payload.wide_camera_index;
  }
  if (payload.wide_camera_index === null) patch.wideCameraIndex = null;
  if (isFiniteNumber(payload.switch_delay_ms)) patch.switchDelayMs = payload.switch_delay_ms;
  if (isFiniteNumber(payload.min_hold_ms)) patch.minHoldMs = payload.min_hold_ms;
  if (isFiniteNumber(payload.silence_to_wide_ms)) patch.silenceToWideMs = payload.silence_to_wide_ms;
  if (isFiniteNumber(payload.multi_talker_to_wide_ms)) {
    patch.multiTalkerToWideMs = payload.multi_talker_to_wide_ms;
  }
  if (isFiniteNumber(payload.boundary_hysteresis_deg)) {
    patch.boundaryHysteresisDeg = payload.boundary_hysteresis_deg;
  }
  if (Array.isArray(payload.zones)) {
    patch.zones = payload.zones
      .map(parseZone)
      .filter((z): z is DirectorZone => z !== null);
  }
  return patch;
}

function parseZone(raw: unknown): DirectorZone | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const z = raw as Record<string, unknown>;
  const cameraIndex = z.camera_index;
  const startDeg = z.start_deg;
  const endDeg = z.end_deg;
  if (
    !isFiniteNumber(cameraIndex) ||
    !isFiniteNumber(startDeg) ||
    !isFiniteNumber(endDeg)
  ) {
    return null;
  }
  const zone: DirectorZone = { cameraIndex, startDeg, endDeg };
  if (typeof z.label === "string") {
    zone.label = z.label;
  }
  return zone;
}

/** Parses a reading payload for the inject command. */
export function parseInjectReading(
  payload: Record<string, unknown>,
): DirectionReading {
  const azimuth = payload.azimuth_deg;
  return {
    azimuthDeg: isFiniteNumber(azimuth) ? azimuth : null,
    active: payload.active !== false && azimuth !== null,
    talkerCount: isFiniteNumber(payload.talker_count)
      ? payload.talker_count
      : payload.active === false
        ? 0
        : 1,
    sourceTsMs: Date.now(),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Process-wide singleton, mirroring the conference display output service. */
export const conferenceDirectorService = new ConferenceDirectorService();
