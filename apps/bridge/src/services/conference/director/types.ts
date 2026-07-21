/**
 * Conference auto-director ("Auto-Regie") — shared types.
 *
 * The director follows the active speaker across cameras. Professional rooms
 * solve "who is speaking, from where" with a beamforming ceiling microphone
 * array (Shure Microflex, Sennheiser TeamConnect, …). Every such array is
 * reduced to ONE brand-agnostic signal — a horizontal angle plus an
 * "is-anyone-speaking" flag — so the decision engine never needs to know the
 * brand. See {@link DirectionReading}.
 */

/**
 * A normalized "active talker direction" reading, brand-agnostic.
 *
 * Shure reports X/Y/Z centimetres (we derive the angle via atan2); Sennheiser
 * reports the azimuth directly. Both collapse to this shape.
 */
export type DirectionReading = {
  /**
   * Horizontal angle of the active talker in degrees, normalized to [0,360),
   * or null when the source cannot localize (no talker / outside coverage).
   */
  azimuthDeg: number | null;
  /** True when the array currently detects speech (its voice-activity gate). */
  active: boolean;
  /**
   * Number of simultaneous talkers the array reports. >= 2 is treated as
   * ambiguous by the director and steers toward the wide/group shot rather
   * than ping-ponging between speakers.
   */
  talkerCount: number;
  /** Source-side timestamp (ms) when this reading was produced. */
  sourceTsMs: number;
};

/**
 * Maps a horizontal angle range to a program camera. A zone is an arc that
 * starts at {@link startDeg} and runs clockwise to {@link endDeg}; if
 * endDeg <= startDeg the arc wraps past 360°.
 */
export type DirectorZone = {
  /** Program camera index to cut to when the talker is inside this arc. */
  cameraIndex: number;
  /** Arc start angle in degrees [0,360). */
  startDeg: number;
  /** Arc end angle in degrees [0,360); wraps past 360 when <= startDeg. */
  endDeg: number;
  /** Optional label for the UI (e.g. "Tisch links"). */
  label?: string;
};

/**
 * Tunables for the decision engine. Defaults mirror the timings professional
 * systems (Q-SYS ACPR, AVer PTZ Link) recommend: a ~2 s dwell before a cut, a
 * minimum hold so the shot cannot flicker, and multi-second fallbacks to the
 * wide shot on silence or crosstalk.
 */
export type AudioDirectorConfig = {
  zones: DirectorZone[];
  /** Camera used as the group/wide fallback on silence or multiple talkers. */
  wideCameraIndex: number | null;
  /** A challenger zone must lead continuously this long before the cut. */
  switchDelayMs: number;
  /** Minimum time the program stays on a shot after any cut. */
  minHoldMs: number;
  /** Continuous silence this long triggers the wide fallback. */
  silenceToWideMs: number;
  /** Two or more simultaneous talkers this long triggers the wide fallback. */
  multiTalkerToWideMs: number;
  /** Extra degrees a talker must pass a zone edge before the zone is left. */
  boundaryHysteresisDeg: number;
};

export const DEFAULT_AUDIO_DIRECTOR_CONFIG: AudioDirectorConfig = {
  zones: [],
  wideCameraIndex: null,
  switchDelayMs: 2000,
  minHoldMs: 1500,
  silenceToWideMs: 8000,
  multiTalkerToWideMs: 1200,
  boundaryHysteresisDeg: 5,
};

/** A direction source pushes {@link DirectionReading}s as talkers move. */
export type DirectionListener = (reading: DirectionReading) => void;

/**
 * Abstraction over a beamforming array. Concrete implementations open the
 * array's network protocol (Shure command strings over TCP, Sennheiser SSC
 * over UDP, …) and emit normalized readings. A mock implementation drives the
 * director in tests and lets the room be dry-run without hardware.
 */
export interface DirectionSource {
  /** Short identifier for logs/status (e.g. "shure", "sennheiser-tcc2"). */
  readonly kind: string;
  /** Connect / subscribe. Readings then arrive via {@link onReading}. */
  start(): Promise<void>;
  /** Disconnect and release resources. Safe to call when already stopped. */
  stop(): Promise<void>;
  /** Register the reading callback (replaces any previous one). */
  onReading(listener: DirectionListener): void;
  /** Whether the source is currently connected to the array. */
  isConnected(): boolean;
  /** Most recent error, or null. */
  lastError(): string | null;
}
