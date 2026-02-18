import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";

/**
 * Stub output adapter that logs and drops frames.
 */
export class StubOutputAdapter implements GraphicsOutputAdapter {
  private configured = false;
  private lastLog = 0;

  /**
   * Configure stub output (no-op other than logging).
   *
   * @param config Output configuration payload.
   */
  async configure(config: GraphicsOutputConfigT): Promise<void> {
    this.configured = true;
    this.log(
      `Configured output: ${config.outputKey} (${JSON.stringify(config.targets)})`
    );
  }

  /**
   * Drop frames, optionally logging periodic ticks.
   *
   * @param frame RGBA frame buffer with width/height metadata.
   * @param config Output configuration payload.
   */
  async sendFrame(
    frame: GraphicsOutputFrameT,
    config: GraphicsOutputConfigT
  ): Promise<void> {
    if (!this.configured) {
      return;
    }

    // Only log frame ticks in debug mode (every 10 seconds instead of every second)
    const now = Date.now();
    if (now - this.lastLog > 10000) {
      this.lastLog = now;
      this.log(
        `Frame tick ${config.outputKey}: ${frame.width}x${frame.height} @ ${new Date(
          frame.timestamp
        ).toISOString()}`
      );
    }
  }

  /**
   * Stop stub output (no-op).
   */
  async stop(): Promise<void> {
    this.configured = false;
  }

  private log(message: string): void {
    if (process.env.BRIDGE_LOG_STUB_OUTPUT !== "1") {
      return;
    }
    console.log(`[GraphicsOutputStub] ${message}`);
  }
}
