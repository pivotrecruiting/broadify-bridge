import { Socket } from "node:net";
import type { SwitcherEventT } from "../../session-log/session-log-types.js";
import { LineSplitter, activatorToEvents, createVmixActivatorState, parseActivatorLine } from "./vmix-activators.js";

export const VMIX_TCP_PORT = 8099;

type VmixActivatorsClientOptionsT = {
  ip: string;
  port?: number;
  onEvent: (event: SwitcherEventT) => void;
  inputName?: (input: number) => string | null;
  reconnectMs?: number;
  connectTimeoutMs?: number;
  createSocket?: () => Socket;
};

/**
 * Real-time switcher events from the vMix TCP API (`SUBSCRIBE ACTS`), in
 * addition to the 2-second HTTP polling the macro control uses. Observability
 * only: connection failures are retried quietly and never surface as engine
 * errors; `close()` stops everything.
 */
export class VmixActivatorsClient {
  private socket: Socket | null = null;
  private closed = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly splitter = new LineSplitter();
  private state = createVmixActivatorState();

  constructor(private readonly options: VmixActivatorsClientOptionsT) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): void {
    if (this.closed) {
      return;
    }
    const socket = this.options.createSocket?.() ?? new Socket();
    this.socket = socket;
    this.state = createVmixActivatorState();
    socket.setTimeout(this.options.connectTimeoutMs ?? 5000);
    socket.once("timeout", () => socket.destroy(new Error("vMix TCP connect timeout")));
    socket.on("connect", () => {
      socket.setTimeout(0);
      socket.write("SUBSCRIBE ACTS\r\n");
    });
    socket.on("data", (chunk: Buffer) => {
      for (const line of this.splitter.push(chunk.toString("utf8"))) {
        this.handleLine(line);
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => {
      if (this.socket === socket) {
        this.socket = null;
        this.scheduleReconnect();
      }
    });
    socket.connect(this.options.port ?? VMIX_TCP_PORT, this.options.ip);
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectMs ?? 5000);
    this.reconnectTimer.unref?.();
  }

  private handleLine(line: string): void {
    const parsed = parseActivatorLine(line);
    if (!parsed) {
      return;
    }
    try {
      for (const event of activatorToEvents(parsed, this.state, this.options.inputName)) {
        this.options.onEvent({ ...event, at_ms: Date.now() });
      }
    } catch {
      // never break the feed
    }
  }
}
