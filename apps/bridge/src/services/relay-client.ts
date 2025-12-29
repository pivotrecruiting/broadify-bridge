import { WebSocket } from "ws";
import { commandRouter } from "./command-router.js";
import type { RelayCommand } from "./command-router.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

/**
 * Relay message types
 */
interface BridgeHelloMessage {
  type: "bridge_hello";
  bridgeId: string;
  version: string;
}

interface RelayCommandMessage {
  type: "command";
  requestId: string;
  command: RelayCommand;
  payload?: Record<string, unknown>;
}

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
  private reconnectAttempts = 0;
  private maxReconnectAttempts = Infinity; // Retry indefinitely
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

  constructor(
    bridgeId: string,
    relayUrl: string,
    logger?: {
      info: (msg: string) => void;
      error: (msg: string) => void;
      warn: (msg: string) => void;
    }
  ) {
    this.bridgeId = bridgeId;
    this.relayUrl = relayUrl;
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
   * Connect to relay server
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

    this.send(message);
    this.logger.info(`Sent bridge_hello with bridgeId: ${this.bridgeId}`);
  }

  /**
   * Handle incoming message from relay
   */
  private async handleMessage(data: WebSocket.Data): Promise<void> {
    try {
      const message: RelayMessage = JSON.parse(data.toString());
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
   * Handle command from relay
   */
  private async handleCommand(message: RelayCommandMessage): Promise<void> {
    this.logger.info(
      `Received command: ${message.command} (requestId: ${message.requestId})`
    );

    try {
      const result = await commandRouter.handleCommand(
        message.command,
        message.payload
      );

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
