import dgram from "node:dgram";
import { DirectionListener, DirectionSource } from "./types.js";

export type SennheiserTcc2Options = {
  /** IP address of the TeamConnect Ceiling 2 array. */
  host: string;
  /** SSCv1 UDP port. Fixed at 45 on TCC2 ("Sennheiser was founded in 1945"). */
  port?: number;
  /** Rotation so azimuth 0° matches the room/camera reference. */
  azimuthOffsetDeg?: number;
};

const DEFAULT_PORT = 45;
// UDP SSC sessions expire after 60 s of silence; ping well inside that window.
const PING_INTERVAL_MS = 25000;
const RESUBSCRIBE_INTERVAL_MS = 45000;

/**
 * Reads the active-talker beam direction from a Sennheiser TeamConnect Ceiling
 * 2 array over the SSCv1 protocol and normalizes it to {@link DirectionReading}s.
 *
 * Protocol (from Sennheiser's SSC / TI 1245 spec):
 *  - SSC = OSC-over-JSON. Transport is UDP on port 45, no authentication.
 *  - Subscribe to `/m/beam/azimuth` (0..359°) and `/audio/room_in_use` (a
 *    coarse near-end voice-activity flag) via `/osc/state/subscribe`. The
 *    device then pushes `{"m":{"beam":{"azimuth":231}}}` and
 *    `{"audio":{"room_in_use":true}}` notifications on change.
 *  - On UDP the session drops after 60 s of inactivity, so we send
 *    `{"osc":{"ping":null}}` periodically and re-subscribe occasionally.
 *
 * TCC2 reports a single beam pointed at the loudest talker, so talkerCount is
 * always 1; the beam holds its last angle during silence, which is why the
 * `room_in_use` flag (not the angle) gates activity.
 */
export class SennheiserTcc2Source implements DirectionSource {
  readonly kind = "sennheiser-tcc2";
  private readonly host: string;
  private readonly port: number;
  private readonly azimuthOffsetDeg: number;

  private socket: dgram.Socket | null = null;
  private listener: DirectionListener | null = null;
  private connected = false;
  private stopped = true;
  private error: string | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private resubscribeTimer: NodeJS.Timeout | null = null;

  private lastAzimuth: number | null = null;
  private roomInUse = false;

  constructor(options: SennheiserTcc2Options) {
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.azimuthOffsetDeg = options.azimuthOffsetDeg ?? 0;
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
    const socket = dgram.createSocket("udp4");
    this.socket = socket;
    socket.on("message", (msg) => this.onMessage(msg));
    // Bind can fail (address in use, permissions) or the socket can error
    // before bind resolves; without a one-shot 'error' reject, start() would
    // hang forever on a half-open socket. Detach the guard on success.
    await new Promise<void>((resolve, reject) => {
      const onBindError = (err: Error) => {
        this.error = err.message;
        reject(err);
      };
      socket.once("error", onBindError);
      socket.bind(() => {
        socket.removeListener("error", onBindError);
        socket.on("error", (err) => {
          this.error = err.message;
        });
        resolve();
      });
    });
    this.connected = true;
    this.subscribe();
    this.pingTimer = setInterval(() => this.send({ osc: { ping: null } }), PING_INTERVAL_MS);
    this.resubscribeTimer = setInterval(() => this.subscribe(), RESUBSCRIBE_INTERVAL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.resubscribeTimer) {
      clearInterval(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.close();
      this.socket = null;
    }
    this.connected = false;
  }

  private subscribe(): void {
    this.send({
      osc: {
        state: {
          subscribe: [
            { m: { beam: { azimuth: null } } },
            { audio: { room_in_use: null } },
          ],
        },
      },
    });
  }

  private send(message: unknown): void {
    if (!this.socket || this.stopped) {
      return;
    }
    const data = Buffer.from(JSON.stringify(message));
    this.socket.send(data, this.port, this.host, (err) => {
      if (err) {
        this.error = err.message;
      }
    });
  }

  private onMessage(msg: Buffer): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(msg.toString());
    } catch {
      return; // Ignore non-JSON / partial datagrams.
    }
    const azimuth = readNumber(parsed, ["m", "beam", "azimuth"]);
    const roomInUse = readBoolean(parsed, ["audio", "room_in_use"]);
    let changed = false;
    if (azimuth !== null) {
      this.lastAzimuth = normalizeDeg(azimuth + this.azimuthOffsetDeg);
      changed = true;
    }
    if (roomInUse !== null) {
      this.roomInUse = roomInUse;
      changed = true;
    }
    if (changed) {
      this.emit();
    }
  }

  private emit(): void {
    this.listener?.({
      // When the room is quiet the beam angle is stale, so report it as null.
      azimuthDeg: this.roomInUse ? this.lastAzimuth : null,
      active: this.roomInUse,
      talkerCount: this.roomInUse ? 1 : 0,
      sourceTsMs: Date.now(),
    });
  }
}

function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Safely walks a nested path and returns a finite number, else null. */
function readNumber(obj: unknown, path: string[]): number | null {
  const value = walk(obj, path);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(obj: unknown, path: string[]): boolean | null {
  const value = walk(obj, path);
  return typeof value === "boolean" ? value : null;
}

function walk(obj: unknown, path: string[]): unknown {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur === null || typeof cur !== "object") {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}
