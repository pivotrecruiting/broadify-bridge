import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
  HelperLifecycleEventT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { getBridgeContext } from "../../bridge-context.js";
import { resolveDecklinkHelperPath } from "../../../modules/decklink/decklink-helper.js";
import { KEY_FILL_PIXEL_FORMAT_PRIORITY } from "../output-format-policy.js";
import { parseDecklinkPortId } from "./decklink-port.js";
import { HelperProcessSession } from "./helper-process-session.js";
const FRAME_MAGIC = 0x42524746; // 'BRGF'
const FRAME_VERSION = 1;
const FRAME_TYPE_SHUTDOWN = 2;
const FRAME_HEADER_LENGTH = 28;

/**
 * DeckLink output adapter for external keying (SDI fill + key).
 *
 * Streams raw RGBA frames to the native helper which performs key/fill output.
 */
export class DecklinkKeyFillOutputAdapter implements GraphicsOutputAdapter {
  private session: HelperProcessSession | null = null;
  private lifecycleListeners = new Set<(event: HelperLifecycleEventT) => void>();

  /**
   * Configure helper process for key/fill output.
   *
   * @param config Output configuration payload (validated upstream).
   */
  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    const output1Id = config.targets.output1Id;
    const output2Id = config.targets.output2Id;
    if (!output1Id || !output2Id) {
      throw new Error("Missing output ports for DeckLink keyer");
    }

    const fillPort = parseDecklinkPortId(output1Id);
    const keyPort = parseDecklinkPortId(output2Id);
    if (!fillPort || !keyPort) {
      throw new Error("Invalid DeckLink port IDs for keyer output");
    }
    if (fillPort.deviceId !== keyPort.deviceId) {
      throw new Error("Fill and key ports must belong to the same device");
    }
    if (fillPort.portRole !== "fill" || keyPort.portRole !== "key") {
      throw new Error("Output ports are not a valid SDI fill/key pair");
    }

    const helperPath = resolveDecklinkHelperPath();
    try {
      await access(helperPath, constants.X_OK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DeckLink helper not executable: ${message}`);
    }
    const args = [
      "--playback",
      "--device",
      fillPort.deviceId,
      "--fill-port",
      output1Id,
      "--key-port",
      output2Id,
      "--width",
      String(config.format.width),
      "--height",
      String(config.format.height),
      "--fps",
      String(config.format.fps),
      "--pixel-format-priority",
      KEY_FILL_PIXEL_FORMAT_PRIORITY.join(","),
      "--range",
      config.range,
      "--colorspace",
      config.colorspace,
    ];

    if (config.format.displayModeId) {
      args.push("--display-mode", String(config.format.displayModeId));
    }

    if (process.env.BRIDGE_FRAMEBUS_NAME) {
      args.push("--framebus-name", process.env.BRIDGE_FRAMEBUS_NAME);
    }

    const env = { ...process.env } as Record<string, string>;
    if (process.env.BRIDGE_FRAMEBUS_NAME) {
      env.BRIDGE_FRAMEBUS_NAME = process.env.BRIDGE_FRAMEBUS_NAME;
    }
    if (process.env.BRIDGE_FRAMEBUS_SIZE) {
      env.BRIDGE_FRAMEBUS_SIZE = process.env.BRIDGE_FRAMEBUS_SIZE;
    }
    if (process.env.BRIDGE_FRAME_WIDTH) {
      env.BRIDGE_FRAME_WIDTH = process.env.BRIDGE_FRAME_WIDTH;
    }
    if (process.env.BRIDGE_FRAME_HEIGHT) {
      env.BRIDGE_FRAME_HEIGHT = process.env.BRIDGE_FRAME_HEIGHT;
    }
    if (process.env.BRIDGE_FRAME_FPS) {
      env.BRIDGE_FRAME_FPS = process.env.BRIDGE_FRAME_FPS;
    }
    if (process.env.BRIDGE_FRAME_PIXEL_FORMAT) {
      env.BRIDGE_FRAME_PIXEL_FORMAT = process.env.BRIDGE_FRAME_PIXEL_FORMAT;
    }

    this.getLogger().debug?.(
      `[DeckLinkOutput] Pixel format priority: ${KEY_FILL_PIXEL_FORMAT_PRIORITY.join(",")}`
    );

    this.session = new HelperProcessSession({
      label: "DeckLinkOutput",
      helperPath,
      args,
      env,
      stdin: "pipe",
      readyTimeoutMs: 12_000,
      stderrLogLevel: "error",
      logUnknownMessages: false,
      stopStrategy: {
        shutdownHeader: this.createShutdownHeader(),
        gracefulMs: 4000,
        forceMs: 2000,
      },
      logger: this.getLogger(),
    });
    this.session.onLifecycle((event) => this.emitLifecycle(event));
    await this.session.start();
  }

  /**
   * Send a single RGBA frame to the helper process.
   *
   * @param frame RGBA frame buffer with width/height metadata.
   * @param _config Output configuration (unused here).
   */
  async sendFrame(
    _frame: GraphicsOutputFrameT,
    _config: GraphicsOutputConfigT
  ): Promise<void> {
    // FrameBus is always used; helpers read from shared memory. No-op.
  }

  /**
   * Stop helper process and release resources.
   */
  async stop(): Promise<void> {
    await this.session?.stop();
    this.session = null;
  }

  onLifecycle(cb: (event: HelperLifecycleEventT) => void): () => void {
    this.lifecycleListeners.add(cb);
    return () => {
      this.lifecycleListeners.delete(cb);
    };
  }

  private createShutdownHeader(): Buffer {
    const header = Buffer.alloc(FRAME_HEADER_LENGTH);
    header.writeUInt32BE(FRAME_MAGIC, 0);
    header.writeUInt16BE(FRAME_VERSION, 4);
    header.writeUInt16BE(FRAME_TYPE_SHUTDOWN, 6);
    header.writeUInt32BE(0, 8);
    header.writeUInt32BE(0, 12);
    header.writeBigUInt64BE(BigInt(Date.now()), 16);
    header.writeUInt32BE(0, 24);
    return header;
  }

  private emitLifecycle(event: HelperLifecycleEventT): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }

  private getLogger() {
    try {
      return getBridgeContext().logger;
    } catch {
      return console;
    }
  }

}
