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

  async configure(config: GraphicsOutputConfigT): Promise<void> {
    this.configured = true;
    this.log(
      `Configured output: ${config.outputKey} (${JSON.stringify(config.targets)})`
    );
  }

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

  async stop(): Promise<void> {
    this.configured = false;
  }

  private log(message: string): void {
    console.log(`[GraphicsOutputStub] ${message}`);
  }
}
