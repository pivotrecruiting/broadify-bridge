import net from "node:net";
import { DirectionListener, DirectionReading, DirectionSource } from "./types.js";

export type ShureSourceOptions = {
  /** Shure Control IP of the array (NOT the Dante audio IP). */
  host: string;
  /** Command-strings TCP port. Fixed at 2202 on Microflex Advance devices. */
  port?: number;
  /**
   * Talker-position reporting period in ms (100..99999). The device only emits
   * a SAMPLE when a talker is active, so this is the max cadence, not a rate.
   */
  reportRateMs?: number;
  /**
   * Rotation applied to the derived angle so azimuth 0° lines up with the
   * room/camera reference. The raw angle is atan2(Y, X); the install
   * orientation determines the offset.
   */
  azimuthOffsetDeg?: number;
  /**
   * If no SAMPLE arrives for this long, emit a synthetic silence reading.
   * Shure reports nothing during silence, so we detect it by absence.
   */
  silenceGapMs?: number;
};

const DEFAULT_PORT = 2202;
const DEFAULT_RATE_MS = 100;
const DEFAULT_SILENCE_GAP_MS = 500;
const RECONNECT_DELAY_MS = 3000;

/**
 * Reads active-talker positions from a Shure Microflex Advance array (MXA920
 * and family) over the command-strings TCP interface and normalizes them to
 * {@link DirectionReading}s.
 *
 * Protocol (from Shure's MXA920 command-strings spec):
 *  - Plain-text `< ... >` commands over TCP 2202, no auth. Telnet negotiation
 *    must be off — a raw socket never negotiates, and we defensively strip any
 *    IAC (0xFF) bytes the device sends.
 *  - `< SET TALKER_POSITION_RATE 00100 >` starts an unsolicited push stream of
 *    `< SAMPLE TALKER_POSITIONS {lobe} {area} {X} {Y} {Z} {reserved} ... >`,
 *    with X/Y/Z in centimetres relative to the device centre. Multiple talkers
 *    arrive as repeated 6-tuples in one line.
 *  - Silence produces NO packets, so we synthesize an inactive reading after a
 *    gap.
 *
 * The horizontal angle is derived as atan2(Y, X); Z (height) is ignored for
 * left/right camera selection.
 */
export class ShureDirectionSource implements DirectionSource {
  readonly kind = "shure";
  private readonly host: string;
  private readonly port: number;
  private readonly reportRateMs: number;
  private readonly azimuthOffsetDeg: number;
  private readonly silenceGapMs: number;

  private socket: net.Socket | null = null;
  private listener: DirectionListener | null = null;
  private buffer = "";
  private connected = false;
  private stopped = true;
  private error: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private silenceTimer: NodeJS.Timeout | null = null;

  constructor(options: ShureSourceOptions) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.reportRateMs = clampRate(options.reportRateMs ?? DEFAULT_RATE_MS);
    this.azimuthOffsetDeg = options.azimuthOffsetDeg ?? 0;
    this.silenceGapMs = options.silenceGapMs ?? DEFAULT_SILENCE_GAP_MS;
  }

  onReading(listener: DirectionListener): void {
    this.listener = listener;
  }

  isConnected(): boolean {
    return this.connected;
  }

  lastError(): string | null {
    return this.error;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private connect(): void {
    if (this.stopped) {
      return;
    }
    const socket = net.createConnection({ host: this.host, port: this.port });
    this.socket = socket;

    socket.on("connect", () => {
      this.connected = true;
      this.error = null;
      // The first command after connect may error on MXA devices; send a
      // throwaway GET to absorb it, then start the talker-position stream.
      socket.write("< GET DEVICE_ID >\r\n");
      socket.write(
        `< SET TALKER_POSITION_RATE ${padRate(this.reportRateMs)} >\r\n`,
      );
      // Shure only emits SAMPLEs while a talker is active, so a cold start (or a
      // reconnect) into a silent room would never arm the silence timer and the
      // director would never fall back to wide. Seed an inactive reading now so
      // the silence path is live from the first moment of the connection.
      this.emit({
        azimuthDeg: null,
        active: false,
        talkerCount: 0,
        sourceTsMs: Date.now(),
      });
      this.armSilenceTimer();
    });
    socket.on("data", (chunk) => this.onData(chunk));
    socket.on("error", (err) => {
      this.error = err.message;
    });
    socket.on("close", () => {
      this.connected = false;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private onData(chunk: Buffer): void {
    // Strip any telnet IAC negotiation bytes (0xFF ...), then accumulate ASCII.
    this.buffer += stripTelnet(chunk);
    let close: number;
    while ((close = this.buffer.indexOf(">")) >= 0) {
      const open = this.buffer.lastIndexOf("<", close);
      const frame = open >= 0 ? this.buffer.slice(open + 1, close) : "";
      this.buffer = this.buffer.slice(close + 1);
      this.handleFrame(frame.trim());
    }
    // Bound the buffer so a malformed stream cannot grow unbounded.
    if (this.buffer.length > 8192) {
      this.buffer = this.buffer.slice(-1024);
    }
  }

  private handleFrame(frame: string): void {
    const tokens = frame.split(/\s+/).filter(Boolean);
    if (tokens[0] !== "SAMPLE" || tokens[1] !== "TALKER_POSITIONS") {
      return; // GET/SET acks and other reports are ignored.
    }
    const coords = tokens.slice(2).map(Number);
    // Each talker is a 6-tuple: lobe, area, X, Y, Z, reserved.
    const talkers: Array<{ x: number; y: number }> = [];
    for (let i = 0; i + 5 < coords.length; i += 6) {
      const x = coords[i + 2];
      const y = coords[i + 3];
      if (Number.isFinite(x) && Number.isFinite(y)) {
        talkers.push({ x, y });
      }
    }
    if (talkers.length === 0) {
      return;
    }
    const first = talkers[0];
    const azimuthDeg = normalizeDeg(
      (Math.atan2(first.y, first.x) * 180) / Math.PI + this.azimuthOffsetDeg,
    );
    this.emit({
      azimuthDeg,
      active: true,
      talkerCount: talkers.length,
      sourceTsMs: Date.now(),
    });
    this.armSilenceTimer();
  }

  private armSilenceTimer(): void {
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
    }
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.emit({
        azimuthDeg: null,
        active: false,
        talkerCount: 0,
        sourceTsMs: Date.now(),
      });
    }, this.silenceGapMs);
  }

  private emit(reading: DirectionReading): void {
    this.listener?.(reading);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}

function clampRate(ms: number): number {
  return Math.min(99999, Math.max(100, Math.round(ms)));
}

function padRate(ms: number): string {
  return String(clampRate(ms)).padStart(5, "0");
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Removes telnet IAC (0xFF) command sequences and returns printable ASCII. */
function stripTelnet(chunk: Buffer): string {
  let out = "";
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] === 0xff) {
      // IAC + command (+ option): skip 2 following bytes conservatively.
      i += 2;
      continue;
    }
    out += String.fromCharCode(chunk[i]);
  }
  return out;
}
