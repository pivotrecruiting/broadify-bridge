import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { getBridgeContext } from "../../bridge-context.js";
import { resolveFfmpegPath } from "../../../utils/ffmpeg-path.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";

type FfmpegNdiProcessT = {
  process: ChildProcessWithoutNullStreams;
  streamName: string;
  alive: boolean;
  backpressure: boolean;
  pendingFrame: Buffer | null;
  ready: Promise<void>;
};

/**
 * Build FFmpeg command-line arguments for NDI output
 */
function buildNdiArgs(
  config: GraphicsOutputConfigT,
  streamName: string
): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${config.format.width}x${config.format.height}`,
    "-r",
    `${config.format.fps}`,
    "-i",
    "pipe:0",
    "-an",
    "-pix_fmt",
    "rgba",
    "-f",
    "libndi_newtek",
    streamName,
  ];
}

/**
 * Write frame to FFmpeg process with backpressure handling
 */
function writeFrameBestEffort(entry: FfmpegNdiProcessT, frame: Buffer): void {
  if (!entry.alive || !entry.process.stdin.writable) {
    return;
  }
  if (entry.backpressure) {
    entry.pendingFrame = frame;
    return;
  }
  const ok = entry.process.stdin.write(frame);
  if (!ok) {
    entry.backpressure = true;
    entry.pendingFrame = frame;
  }
}

/**
 * NDI output adapter using FFmpeg libndi_newtek subprocess.
 * Sends RGBA frames with alpha channel as NDI stream.
 */
export class FfmpegNdiOutputAdapter implements GraphicsOutputAdapter {
  private process: FfmpegNdiProcessT | null = null;
  private configured = false;
  private stopInProgress = false;

  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    const logger = getBridgeContext().logger;
    if (config.outputKey !== "key_fill_ndi") {
      logger.warn(
        `[GraphicsOutput] Unsupported outputKey for FFmpeg NDI adapter: ${config.outputKey}`
      );
      return;
    }

    if (!config.targets.ndiStreamName) {
      throw new Error("NDI stream name is required for key/fill NDI");
    }

    this.process = this.spawnProcess(config, config.targets.ndiStreamName);
    await this.awaitReady();
    this.configured = true;
    logger.info(
      `[GraphicsOutput] NDI key/fill configured (stream: ${config.targets.ndiStreamName})`
    );
  }

  async sendFrame(
    frame: GraphicsOutputFrameT,
    _config: GraphicsOutputConfigT
  ): Promise<void> {
    if (!this.configured || !this.process) {
      return;
    }
    if (this.stopInProgress) {
      return;
    }
    if (!this.process.alive) {
      return;
    }

    writeFrameBestEffort(this.process, frame.rgba);
  }

  async stop(): Promise<void> {
    this.stopInProgress = true;
    if (!this.process) {
      this.configured = false;
      this.stopInProgress = false;
      return;
    }

    this.process.process.stdin.end();
    this.process.process.kill("SIGTERM");

    await this.waitForExit(this.process);

    this.process = null;
    this.configured = false;
    this.stopInProgress = false;
  }

  private spawnProcess(
    config: GraphicsOutputConfigT,
    streamName: string
  ): FfmpegNdiProcessT {
    const logger = getBridgeContext().logger;
    const ffmpegPath = resolveFfmpegPath();
    const args = buildNdiArgs(config, streamName);

    const process = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entry: FfmpegNdiProcessT = {
      process,
      streamName,
      alive: true,
      backpressure: false,
      pendingFrame: null,
      ready: this.waitForReady(process),
    };

    process.stdin.on("drain", () => {
      entry.backpressure = false;
      if (entry.pendingFrame) {
        const ok = process.stdin.write(entry.pendingFrame);
        if (ok) {
          entry.pendingFrame = null;
        } else {
          entry.backpressure = true;
        }
      }
    });

    process.stdout.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        logger.info(`[GraphicsOutput:NDI] ${text}`);
      }
    });

    process.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        logger.error(`[GraphicsOutput:NDI] ${text}`);
      }
    });

    process.on("error", (error) => {
      entry.alive = false;
      logger.error(`[GraphicsOutput:NDI] ${error.message}`);
    });

    process.on("exit", (code, signal) => {
      entry.alive = false;
      logger.warn(
        `[GraphicsOutput:NDI] FFmpeg exited (code=${code}, signal=${signal})`
      );
    });

    return entry;
  }

  private async awaitReady(): Promise<void> {
    if (!this.process) {
      return;
    }
    try {
      await this.process.ready;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private waitForReady(process: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 500);

      const handleExit = (
        code: number | null,
        signal: NodeJS.Signals | null
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(
          new Error(
            `FFmpeg NDI exited during startup (code=${code}, signal=${signal})`
          )
        );
      };

      process.once("exit", handleExit);
      process.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      });
    });
  }

  private async waitForExit(entry: FfmpegNdiProcessT): Promise<void> {
    if (entry.process.exitCode !== null) {
      return;
    }

    try {
      await Promise.race([
        once(entry.process, "exit").then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("Timeout waiting for FFmpeg")),
            2000
          );
        }),
      ]);
    } catch {
      entry.process.kill("SIGKILL");
      await once(entry.process, "exit").catch(() => undefined);
    }
  }
}
