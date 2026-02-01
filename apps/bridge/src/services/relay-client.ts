import { WebSocket } from "ws";
import { commandRouter, isRelayCommand } from "./command-router.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RelayCommand } from "./command-router.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_RELAY_MESSAGE_BYTES = 20 * 1024 * 1024;

/**
 * Get version from package.json
 */
function getVersion(): string {
  try {
    const packagePath = join(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "0.1.0";
  } catch {
    return "0.1.0";
  }
}

const getRelayMessageByteLength = (data: WebSocket.Data): number => {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf-8");
  }
  if (Buffer.isBuffer(data)) {
    return data.length;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.length, 0);
  }
  return 0;
};

const relayMessageToString = (data: WebSocket.Data): string => {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf-8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf-8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf-8");
  }
  return "";
};

/**
 * Relay message types
 */
/**
 * Sent to the relay upon connection to announce bridge identity/version.
 */
interface BridgeHelloMessage {
  type: "bridge_hello";
  bridgeId: string;
  version: string;
  bridgeName?: string;
}

/**
 * Command payload received from relay.
 */
interface RelayCommandMessage {
  type: "command";
  requestId: string;
  command: string;
  payload?: Record<string, unknown>;
}

/**
 * Command result response sent back to relay.
 */
interface CommandResultMessage {
  type: "command_result";
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

type RelayMessage = BridgeHelloMessage | RelayCommandMessage;

/**
 * Relay Client Service
 *
 * Manages outbound WebSocket connection to Relay Server.
 * Handles bridge registration, command reception, and result sending.
 */
export class RelayClient {
  private ws: WebSocket | null = null;
  private bridgeId: string;
  private relayUrl: string;
  private bridgeName?: string;
  private reconnectAttempts = 0;
  private reconnectDelay = 1000; // Start with 1 second
  private maxReconnectDelay = 60000; // Max 60 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private isShuttingDown = false;
  private lastSeen: Date | null = null;
  private logger: {
    info: (msg: string) => void;
    error: (msg: string) => void;
    warn: (msg: string) => void;
  };

  /**
   * Create a relay client instance.
   *
   * @param bridgeId Bridge identifier.
   * @param relayUrl Relay WebSocket URL.
   * @param logger Optional logger implementation.
   * @param bridgeName Optional bridge display name.
   */
  constructor(
    bridgeId: string,
    relayUrl: string,
    logger?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      warn: (msg: string) => void;
    },
    bridgeName?: string
  ) {
    this.bridgeId = bridgeId;
    this.relayUrl = relayUrl;
    this.bridgeName = bridgeName;
    this.logger = logger || {
      info: (msg: string) => console.log(`[RelayClient] ${msg}`),
      error: (msg: string) => console.error(`[RelayClient] ${msg}`),
      warn: (msg: string) => console.warn(`[RelayClient] ${msg}`),
    };
  }

  /**
   * Check if connected to relay
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get last seen timestamp
   */
  getLastSeen(): Date | null {
    return this.lastSeen;
  }

  /**
   * Connect to relay server.
   *
   * @returns Promise resolved when connection attempt is initiated.
   */
  async connect(): Promise<void> {
    if (this.isConnecting || this.isShuttingDown) {
      return;
    }

    if (this.isConnected()) {
      this.logger.info("Already connected to relay");
      return;
    }

    this.isConnecting = true;

    try {
      this.logger.info(`Connecting to relay at ${this.relayUrl}...`);

      this.ws = new WebSocket(this.relayUrl);

      this.ws.on("open", () => {
        this.logger.info("Connected to relay server");
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        this.reconnectDelay = 1000;
        this.lastSeen = new Date();

        // Send bridge_hello message
        this.sendHello();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data);
      });

      this.ws.on("close", () => {
        this.logger.warn("Disconnected from relay server");
        this.ws = null;
        this.isConnecting = false;
        this.lastSeen = null;

        // Attempt reconnect if not shutting down
        if (!this.isShuttingDown) {
          this.scheduleReconnect();
        }
      });

      this.ws.on("error", (error: Error) => {
        this.logger.error(`WebSocket error: ${error.message}`);
        this.isConnecting = false;
      });
    } catch (error: unknown) {
      this.isConnecting = false;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Failed to create WebSocket connection: ${errorMessage}`
      );

      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    }
  }

  /**
   * Send bridge_hello message
   */
  private sendHello(): void {
    if (!this.isConnected()) {
      return;
    }

    const message: BridgeHelloMessage = {
      type: "bridge_hello",
      bridgeId: this.bridgeId,
      version: getVersion(),
    };
    if (this.bridgeName) {
      message.bridgeName = this.bridgeName;
    }

    this.send(message);
    this.logger.info(`Sent bridge_hello with bridgeId: ${this.bridgeId}`);
  }

  /**
   * Handle incoming message from relay.
   *
   * Relay data is untrusted and must be validated downstream.
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const messageSize = getRelayMessageByteLength(data);
      if (messageSize > MAX_RELAY_MESSAGE_BYTES) {
        this.logger.warn(
          `Dropped relay message exceeding size limit (${messageSize} bytes)`
        );
        return;
      }
      const messageText = relayMessageToString(data);
      if (!messageText) {
        this.logger.warn("Dropped relay message: empty payload");
        return;
      }
      const message: RelayMessage = JSON.parse(messageText);
      this.lastSeen = new Date();

      if (message.type === "command") {
        await this.handleCommand(message);
      } else {
        this.logger.warn(
          `Unknown message type: ${(message as { type: string }).type}`
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Error handling message: ${errorMessage}`);
    }
  }

  /**
   * Handle command from relay.
   *
   * @param message Untrusted relay command message.
   */
  private async handleCommand(message: RelayCommandMessage): Promise<void> {
    if (!isRelayCommand(message.command)) {
      this.logger.warn(`Rejected unknown command: ${String(message.command)}`);
      this.send({
        type: "command_result",
        requestId: message.requestId,
        success: false,
        error: "Unknown command",
      });
      return;
    }

    const command = message.command as RelayCommand;
    this.logger.info(
      `Received relay command: ${command} (requestId: ${message.requestId})`
    );

    try {
      const result = await commandRouter.handleCommand(command, message.payload);

      // Send result back to relay
      const resultMessage: CommandResultMessage = {
        type: "command_result",
        requestId: message.requestId,
        success: result.success,
        data: result.data,
        error: result.error,
      };

      this.send(resultMessage);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Send error result
      const resultMessage: CommandResultMessage = {
        type: "command_result",
        requestId: message.requestId,
        success: false,
        error: errorMessage,
      };

      this.send(resultMessage);
    }
  }

  /**
   * Send message to relay
   */
  private send(message: unknown): void {
    if (!this.isConnected() || !this.ws) {
      this.logger.warn("Cannot send message: not connected to relay");
      return;
    }

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`Error sending message: ${errorMessage}`);
    }
  }

  /**
   * Schedule reconnect with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.isShuttingDown) {
      return;
    }

    this.reconnectAttempts++;

    // Exponential backoff: 1s, 2s, 4s, 8s, ... up to 60s
    const delay = Math.min(
      this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    this.logger.info(
      `Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Disconnect from relay
   */
  async disconnect(): Promise<void> {
    this.isShuttingDown = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.logger.info("Disconnected from relay");
  }
}
