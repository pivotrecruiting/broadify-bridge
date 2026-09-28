import { createConnection, type Socket } from "net";
import { createSocket, type Socket as DgramSocketT } from "dgram";
import { EventEmitter } from "events";
import type {
  EngineAdapter,
  EngineConnectConfig,
} from "../engine-adapter-interface.js";
import type {
  EngineStatusT,
  MacroT,
  MacroStatusT,
  EngineStateT,
} from "../../engine-types.js";
import {
  EngineError,
  EngineErrorCode,
  createConnectionTimeoutError,
  createConnectionRefusedError,
  createNetworkError,
  createDeviceUnreachableError,
} from "../engine-errors.js";
import { encodeOscMessage, decodeOscPacket } from "./rcv-osc.js";
import { frameRcvPacket, RcvFrameSplitter } from "./rcv-frame-codec.js";

/**
 * RØDECaster Video (RCV / RCV S / RCV Core) adapter implementation.
 *
 * Speaks OSC over a persistent TCP connection (default port 10024, 4-byte
 * little-endian length prefix per packet). After connecting, the adapter
 * subscribes to device state via "/show" and "/remote"; the device then
 * pushes program/overlay/record/stream changes which are mapped onto the
 * synthetic macro catalog below.
 *
 * Macro ID ranges (stable, never repurposed — gaps are reserved):
 *   1–7   Scene 1–7            /device/scene <n>
 *   11–17 Overlay 1–7 Toggle   /device/toggleOverlay <n>
 *   21–27 Media 1–7            /device/media <n>
 *   31/32 Cut / Auto           /device/button 105|106
 *   41–43 Transition type      /show/transition fade|dip|wipe
 *   51/52 Record Start/Stop    /show/record 1|0
 *   53/54 Stream Start/Stop    /show/live 1|0
 *
 * There is no adapter-internal reconnect loop: on an unexpected socket loss
 * the state drops to "error" and the EngineConnectionSupervisor above the
 * adapter drives the reconnect attempts.
 */
export class RodecasterAdapter extends EventEmitter implements EngineAdapter {
  private state: EngineStateT = {
    status: "disconnected",
    macros: [],
  };
  private readonly connectTimeoutMs = 12000; // matches the device's own remote clients
  private socket: Socket | null = null;
  private splitter = new RcvFrameSplitter();
  private disconnecting = false;
  private lastSocketError: string | null = null;
  private udpSocket: DgramSocketT | null = null;
  private udpTimer: NodeJS.Timeout | null = null;

  // Live device state, expressed as macro IDs (null = none live).
  private liveSceneMacroId: number | null = null;
  private liveOverlayMacroId: number | null = null;
  private liveMediaMacroId: number | null = null;
  private recording = false;
  private streaming = false;

  /**
   * Connect to a RØDECaster Video on the network.
   */
  async connect(config: EngineConnectConfig): Promise<void> {
    if (config.type !== "rodecaster") {
      throw new Error(
        `RodecasterAdapter only supports type "rodecaster", got "${config.type}"`
      );
    }

    if (
      this.state.status === "connected" ||
      this.state.status === "connecting"
    ) {
      throw new Error("Engine is already connected or connecting");
    }

    this.disconnecting = false;
    this.lastSocketError = null;
    this.splitter.reset();
    this.resetLiveState();

    this.setState({
      status: "connecting",
      ip: config.ip,
      port: config.port,
      type: config.type,
    });

    try {
      await this.openSocket(config.ip, config.port);

      this.setState({
        status: "connected",
        macros: buildRodecasterMacroCatalog(),
        error: undefined,
        errorCode: undefined,
      });

      // Subscribe to the state feeds; the device answers with a full "/show"
      // dump (blob XML) and pushes deltas afterwards.
      this.send("/show");
      this.send("/remote");

      // Best-effort device identification (model / firmware) via UDP probe.
      this.probeDeviceInfo(config.ip);
    } catch (error: unknown) {
      this.teardownSocket();
      const engineError = this.classifyConnectError(
        error,
        config.ip,
        config.port
      );
      this.setState({
        status: "error",
        error: engineError.message,
        errorCode: engineError.code,
      });
      throw engineError;
    }
  }

  /**
   * Disconnect from the device. Safe to call repeatedly; leaves the adapter
   * ready for a fresh connect() (the supervisor relies on this).
   */
  async disconnect(): Promise<void> {
    this.disconnecting = true;
    this.teardownSocket();
    this.resetLiveState();

    this.setState({
      status: "disconnected",
      macros: [],
      ip: undefined,
      port: undefined,
      type: undefined,
      error: undefined,
      errorCode: undefined,
    });
  }

  getStatus(): EngineStatusT {
    return this.state.status;
  }

  getMacros(): MacroT[] {
    return [...this.state.macros];
  }

  /**
   * Run a macro by ID (see the catalog in the class doc).
   */
  async runMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    const commands = resolveRunCommands(id);
    if (!commands) {
      throw new Error(`Unknown RØDECaster macro ID: ${id}`);
    }

    for (const [address, args] of commands) {
      await this.sendAsync(address, args);
    }
  }

  /**
   * Stop a macro by ID. Scenes/media/cut/auto/transitions are momentary and
   * resolve as a no-op; overlays toggle off again, record/stream stop. The
   * controls UI sends stop for a macro whose status is "running", so this
   * doubles as the toggle-off path.
   */
  async stopMacro(id: number): Promise<void> {
    if (this.state.status !== "connected") {
      throw new Error("Engine is not connected");
    }

    const commands = resolveStopCommands(id);
    if (commands === undefined) {
      throw new Error(`Unknown RØDECaster macro ID: ${id}`);
    }

    for (const [address, args] of commands) {
      await this.sendAsync(address, args);
    }
  }

  onStateChange(callback: (state: EngineStateT) => void): () => void {
    this.on("stateChange", callback);
    return () => {
      this.off("stateChange", callback);
    };
  }

  getState(): EngineStateT {
    return { ...this.state };
  }

  /**
   * Open the TCP socket and wire the stream handlers. Resolves once the
   * connection is established.
   */
  private openSocket(ip: string, port: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const socket = createConnection({ host: ip, port });
      this.socket = socket;

      const connectTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connect ETIMEDOUT ${ip}:${port}`));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        socket.setKeepAlive(true, 15000);
        resolve();
      });

      socket.on("data", (chunk) => this.handleData(chunk));

      socket.on("error", (error: Error) => {
        this.lastSocketError = error.message;
        if (!settled) {
          settled = true;
          clearTimeout(connectTimer);
          reject(error);
        }
      });

      socket.on("close", () => {
        clearTimeout(connectTimer);
        this.handleSocketClose();
      });
    });
  }

  /**
   * Unexpected socket loss while connected drops the state to "error" so the
   * connection supervisor can schedule reconnect attempts.
   */
  private handleSocketClose(): void {
    if (this.disconnecting || this.state.status !== "connected") {
      return;
    }

    const target = `${this.state.ip}:${this.state.port}`;
    const reason = this.lastSocketError
      ? ` (${this.lastSocketError})`
      : "";
    const engineError = new EngineError(
      EngineErrorCode.NETWORK_ERROR,
      `Connection to RØDECaster Video at ${target} was lost${reason}.`,
      { ip: this.state.ip, port: this.state.port }
    );

    this.teardownSocket();
    this.setState({
      status: "error",
      error: engineError.message,
      errorCode: engineError.code,
    });
  }

  private handleData(chunk: Buffer): void {
    let frames: Buffer[];
    try {
      frames = this.splitter.push(chunk);
    } catch (error: unknown) {
      // Oversized frame: the stream cannot be trusted any more.
      console.error(
        `[RodecasterAdapter] Dropping connection: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      this.socket?.destroy();
      return;
    }

    for (const frame of frames) {
      for (const message of decodeOscPacket(frame)) {
        this.handleIncomingMessage(message.address, message.args);
      }
    }
  }

  /**
   * Map incoming device state onto the macro catalog. Only the addresses
   * relevant to the v1 feedback scope are handled; everything else is
   * ignored on purpose.
   */
  private handleIncomingMessage(
    address: string,
    args: Array<number | string | Buffer>
  ): void {
    if (address === "/show" && Buffer.isBuffer(args[0])) {
      this.applyShowDump(args[0].toString("utf8"));
      return;
    }

    if (address.startsWith("/show/pgmcurrent")) {
      const inputType = String(args[0]);
      const inputId = Number(args[1]); // 1-based
      if (inputType === "scene") {
        this.liveSceneMacroId = toMacroId(inputId, SCENE_MACRO_BASE);
        this.liveMediaMacroId = null;
      } else if (inputType === "media") {
        this.liveMediaMacroId = toMacroId(inputId, MEDIA_MACRO_BASE);
        this.liveSceneMacroId = null;
      } else {
        // "videoIn" or unknown: neither a scene nor a media slot is live.
        this.liveSceneMacroId = null;
        this.liveMediaMacroId = null;
      }
      this.applyLiveState();
      return;
    }

    if (address.startsWith("/show/PgmOverlay")) {
      const overlayIndex = Number(args[0]); // 0-based, -1 = none
      this.liveOverlayMacroId = toMacroId(overlayIndex + 1, OVERLAY_MACRO_BASE);
      this.applyLiveState();
      return;
    }

    if (address === "/show/record") {
      this.recording = Number(args[0]) === 1;
      this.applyLiveState();
      return;
    }

    if (address === "/show/live") {
      this.streaming = Number(args[0]) === 1;
      this.applyLiveState();
      return;
    }
  }

  /**
   * The initial "/show" answer is an XML dump ("RcvShow"). Only the current
   * program scene/overlay attributes are extracted (0-based, -1 = none);
   * everything else in the dump is out of the v1 feedback scope.
   */
  private applyShowDump(xml: string): void {
    const pgmScene = matchIntAttribute(xml, "PgmScene");
    if (pgmScene !== null) {
      this.liveSceneMacroId = toMacroId(pgmScene + 1, SCENE_MACRO_BASE);
    }

    const pgmOverlay = matchIntAttribute(xml, "PgmOverlay");
    if (pgmOverlay !== null) {
      this.liveOverlayMacroId = toMacroId(pgmOverlay + 1, OVERLAY_MACRO_BASE);
    }

    this.applyLiveState();
  }

  /**
   * Recompute macro statuses from the live device state; emit only when
   * something actually changed to keep the stateChange stream quiet.
   */
  private applyLiveState(): void {
    if (this.state.status !== "connected") {
      return;
    }

    let changed = false;
    const macros = this.state.macros.map((macro) => {
      const status = this.statusForMacro(macro.id);
      if (macro.status === status) {
        return macro;
      }
      changed = true;
      return { ...macro, status };
    });

    if (changed) {
      this.setState({ macros });
    }
  }

  private statusForMacro(id: number): MacroStatusT {
    if (
      id === this.liveSceneMacroId ||
      id === this.liveOverlayMacroId ||
      id === this.liveMediaMacroId
    ) {
      return "running";
    }
    if (id === MACRO_ID_RECORD_START && this.recording) {
      return "running";
    }
    if (id === MACRO_ID_STREAM_START && this.streaming) {
      return "running";
    }
    return "idle";
  }

  private send(address: string, args: ReadonlyArray<number | string> = []): void {
    this.socket?.write(frameRcvPacket(encodeOscMessage(address, args)));
  }

  private sendAsync(
    address: string,
    args: ReadonlyArray<number | string> = []
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const socket = this.socket;
      if (!socket) {
        reject(new Error("Engine is not connected"));
        return;
      }
      socket.write(frameRcvPacket(encodeOscMessage(address, args)), (error) => {
        if (error) {
          reject(new Error(`Failed to send ${address}: ${error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Best-effort device identification: unicast UDP probe ("RodeBroadcast")
   * to port 9999; the device answers with an RcvDevice XML snippet. Failure
   * is silent — identification is informational only. The serial number is
   * intentionally not logged.
   */
  private probeDeviceInfo(ip: string): void {
    this.closeUdpProbe();

    try {
      const udpSocket = createSocket("udp4");
      this.udpSocket = udpSocket;

      udpSocket.on("message", (message) => {
        const xml = message.toString("utf8");
        const name = matchStringAttribute(xml, "name");
        const swVersion = matchStringAttribute(xml, "sw_version");
        const model = matchIntAttribute(xml, "device_model");
        if (name !== null || model !== null) {
          console.info(
            `[RodecasterAdapter] Device identified: ${name ?? "unknown"} (${
              rcvModelName(model)
            }, firmware ${swVersion ?? "unknown"})`
          );
        }
        this.closeUdpProbe();
      });

      udpSocket.on("error", () => {
        this.closeUdpProbe();
      });

      udpSocket.send(RCV_DISCOVERY_PROBE, RCV_DISCOVERY_PORT, ip, (error) => {
        if (error) {
          this.closeUdpProbe();
          return;
        }
        this.udpTimer = setTimeout(() => {
          this.closeUdpProbe();
        }, RCV_DISCOVERY_TIMEOUT_MS);
        this.udpTimer.unref?.();
      });
    } catch {
      this.closeUdpProbe();
    }
  }

  private closeUdpProbe(): void {
    if (this.udpTimer) {
      clearTimeout(this.udpTimer);
      this.udpTimer = null;
    }
    if (this.udpSocket) {
      try {
        this.udpSocket.close();
      } catch {
        // Already closed.
      }
      this.udpSocket = null;
    }
  }

  private teardownSocket(): void {
    this.closeUdpProbe();
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
      this.socket = null;
    }
    this.splitter.reset();
  }

  private resetLiveState(): void {
    this.liveSceneMacroId = null;
    this.liveOverlayMacroId = null;
    this.liveMediaMacroId = null;
    this.recording = false;
    this.streaming = false;
  }

  private classifyConnectError(
    error: unknown,
    ip: string,
    port: number
  ): EngineError {
    if (error instanceof EngineError) {
      return error;
    }
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (
      errorMessage.includes("ECONNREFUSED") ||
      errorMessage.includes("refused") ||
      errorMessage.includes("ECONNRESET")
    ) {
      return createConnectionRefusedError(ip, port);
    }
    if (
      errorMessage.includes("ENOTFOUND") ||
      errorMessage.includes("EHOSTUNREACH") ||
      errorMessage.includes("getaddrinfo")
    ) {
      return createDeviceUnreachableError(ip, port);
    }
    if (
      errorMessage.includes("ETIMEDOUT") ||
      errorMessage.includes("timeout") ||
      errorMessage.includes("aborted")
    ) {
      return createConnectionTimeoutError(ip, port, this.connectTimeoutMs);
    }
    return createNetworkError(
      ip,
      port,
      error instanceof Error ? error : undefined
    );
  }

  private setState(updates: Partial<EngineStateT>): void {
    this.state = {
      ...this.state,
      ...updates,
      lastUpdate: Date.now(),
    };
    this.emit("stateChange", this.getState());
  }
}

// --- Macro catalog -----------------------------------------------------------

const SLOT_COUNT = 7;
const SCENE_MACRO_BASE = 0; // macro id = base + slot (slot 1..7)
const OVERLAY_MACRO_BASE = 10;
const MEDIA_MACRO_BASE = 20;
const MACRO_ID_CUT = 31;
const MACRO_ID_AUTO = 32;
const MACRO_ID_TRANSITION_FADE = 41;
const MACRO_ID_TRANSITION_DIP = 42;
const MACRO_ID_TRANSITION_WIPE = 43;
const MACRO_ID_RECORD_START = 51;
const MACRO_ID_RECORD_STOP = 52;
const MACRO_ID_STREAM_START = 53;
const MACRO_ID_STREAM_STOP = 54;

// Physical control-surface button codes (from the device's remote protocol).
const RCV_BUTTON_CUT = 105;
const RCV_BUTTON_AUTO = 106;

const RCV_DISCOVERY_PROBE = Buffer.from("RodeBroadcast");
const RCV_DISCOVERY_PORT = 9999;
const RCV_DISCOVERY_TIMEOUT_MS = 2000;

type OscCommandT = [address: string, args: ReadonlyArray<number | string>];

/**
 * Build the static macro catalog exposed to the controls/StreamDeck UI.
 * All three RCV models expose 7 scene/overlay/media slots over the remote
 * protocol; unassigned slots are simply no-ops on the device.
 */
export function buildRodecasterMacroCatalog(): MacroT[] {
  const macros: MacroT[] = [];

  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    macros.push({ id: SCENE_MACRO_BASE + slot, name: `Scene ${slot}`, status: "idle" });
  }
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    macros.push({
      id: OVERLAY_MACRO_BASE + slot,
      name: `Overlay ${slot} Toggle`,
      status: "idle",
    });
  }
  for (let slot = 1; slot <= SLOT_COUNT; slot++) {
    macros.push({ id: MEDIA_MACRO_BASE + slot, name: `Media ${slot}`, status: "idle" });
  }

  macros.push({ id: MACRO_ID_CUT, name: "Cut", status: "idle" });
  macros.push({ id: MACRO_ID_AUTO, name: "Auto", status: "idle" });
  macros.push({ id: MACRO_ID_TRANSITION_FADE, name: "Transition Fade", status: "idle" });
  macros.push({ id: MACRO_ID_TRANSITION_DIP, name: "Transition Dip", status: "idle" });
  macros.push({ id: MACRO_ID_TRANSITION_WIPE, name: "Transition Wipe", status: "idle" });
  macros.push({ id: MACRO_ID_RECORD_START, name: "Record Start", status: "idle" });
  macros.push({ id: MACRO_ID_RECORD_STOP, name: "Record Stop", status: "idle" });
  macros.push({ id: MACRO_ID_STREAM_START, name: "Stream Start", status: "idle" });
  macros.push({ id: MACRO_ID_STREAM_STOP, name: "Stream Stop", status: "idle" });

  return macros;
}

function slotFromRange(id: number, base: number): number | null {
  const slot = id - base;
  return slot >= 1 && slot <= SLOT_COUNT ? slot : null;
}

/** OSC command sequence for runMacro, or null for unknown IDs. */
function resolveRunCommands(id: number): OscCommandT[] | null {
  const sceneSlot = slotFromRange(id, SCENE_MACRO_BASE);
  if (sceneSlot !== null) {
    return [["/device/scene", [sceneSlot]]];
  }
  const overlaySlot = slotFromRange(id, OVERLAY_MACRO_BASE);
  if (overlaySlot !== null) {
    return [["/device/toggleOverlay", [overlaySlot]]];
  }
  const mediaSlot = slotFromRange(id, MEDIA_MACRO_BASE);
  if (mediaSlot !== null) {
    return [["/device/media", [mediaSlot]]];
  }

  switch (id) {
    case MACRO_ID_CUT:
      return [["/device/button", [RCV_BUTTON_CUT, 1]]];
    case MACRO_ID_AUTO:
      return [["/device/button", [RCV_BUTTON_AUTO, 1]]];
    case MACRO_ID_TRANSITION_FADE:
      return [["/show/transition", ["fade"]]];
    case MACRO_ID_TRANSITION_DIP:
      return [
        ["/show/transition", ["dip"]],
        ["/show/transition_data", ["dipBlack"]],
      ];
    case MACRO_ID_TRANSITION_WIPE:
      return [
        ["/show/transition", ["wipe"]],
        ["/show/transition_data", ["leftright"]],
      ];
    case MACRO_ID_RECORD_START:
      return [["/show/record", [1]]];
    case MACRO_ID_RECORD_STOP:
      return [["/show/record", [0]]];
    case MACRO_ID_STREAM_START:
      return [["/show/live", [1]]];
    case MACRO_ID_STREAM_STOP:
      return [["/show/live", [0]]];
    default:
      return null;
  }
}

/**
 * OSC command sequence for stopMacro: [] = momentary macro, stop is a no-op;
 * undefined = unknown ID.
 */
function resolveStopCommands(id: number): OscCommandT[] | undefined {
  const overlaySlot = slotFromRange(id, OVERLAY_MACRO_BASE);
  if (overlaySlot !== null) {
    return [["/device/toggleOverlay", [overlaySlot]]];
  }
  if (id === MACRO_ID_RECORD_START) {
    return [["/show/record", [0]]];
  }
  if (id === MACRO_ID_STREAM_START) {
    return [["/show/live", [0]]];
  }
  return resolveRunCommands(id) ? [] : undefined;
}

/** Map a 1-based slot onto its macro ID; out-of-range slots become null. */
function toMacroId(slot: number, base: number): number | null {
  return slot >= 1 && slot <= SLOT_COUNT ? base + slot : null;
}

function matchIntAttribute(xml: string, attribute: string): number | null {
  const match = xml.match(new RegExp(`\\b${attribute}="(-?\\d+)"`));
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function matchStringAttribute(xml: string, attribute: string): string | null {
  const match = xml.match(new RegExp(`\\b${attribute}="([^"]*)"`));
  return match ? match[1] : null;
}

function rcvModelName(model: number | null): string {
  switch (model) {
    case 0:
      return "RØDECaster Video";
    case 1:
      return "RØDECaster Video S";
    case 2:
      return "RØDECaster Video Core";
    default:
      return "unknown model";
  }
}
