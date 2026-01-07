import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { getBridgeContext } from "../../bridge-context.js";
import { deviceCache } from "../../device-cache.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";

type FfmpegProcessT = {
  process: ChildProcessWithoutNullStreams;
  target: string;
  kind: "fill" | "key";
  alive: boolean;
  backpressure: boolean;
  pendingFrame: Buffer | null;
  ready: Promise<void>;
};

/**
 * Resolve FFmpeg executable path
 *
 * Priority:
 * 1. FFMPEG_PATH environment variable
 * 2. Bundled FFmpeg in production (from resources/ffmpeg)
 * 3. System FFmpeg (fallback)
 */
function resolveFfmpegPath(): string {
  // Check environment variable first
  if (process.env.FFMPEG_PATH) {
    return process.env.FFMPEG_PATH;
  }

  // In production, use bundled FFmpeg from resources
  // process.resourcesPath is set by Electron and points to the resources directory
  if (
    process.env.NODE_ENV === "production" &&
    typeof process.resourcesPath !== "undefined"
  ) {
    const platform = process.platform;
    const arch = process.arch;

    let platformDir = "";
    if (platform === "darwin") {
      platformDir = arch === "arm64" ? "mac-arm64" : "mac-x64";
    } else if (platform === "win32") {
      platformDir = "win";
    } else if (platform === "linux") {
      platformDir = "linux";
    }

    if (platformDir) {
      const bundledPath = path.join(
        process.resourcesPath,
        "ffmpeg",
        platformDir,
        platform === "win32" ? "ffmpeg.exe" : "ffmpeg"
      );

      // Check if bundled FFmpeg exists
      if (fs.existsSync(bundledPath)) {
        return bundledPath;
      }
    }
  }

  // Fallback to system FFmpeg
  return "ffmpeg";
}

function buildVideoArgs(config: GraphicsOutputConfigT, target: string): string[] {
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
    "uyvy422",
    "-f",
    "decklink",
    target,
  ];
}

function buildKeyArgs(config: GraphicsOutputConfigT, target: string): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "gray",
    "-s",
    `${config.format.width}x${config.format.height}`,
    "-r",
    `${config.format.fps}`,
    "-i",
    "pipe:0",
    "-an",
    "-pix_fmt",
    "uyvy422",
    "-f",
    "decklink",
    target,
  ];
}

function fillAlphaChannel(rgba: Buffer, target: Buffer): void {
  let outIndex = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    target[outIndex] = rgba[i];
    outIndex += 1;
  }
}

function writeFrameBestEffort(
  entry: FfmpegProcessT,
  frame: Buffer
): void {
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
 * SDI output adapter using FFmpeg DeckLink subprocesses.
 */
export class FfmpegSdiOutputAdapter implements GraphicsOutputAdapter {
  private processes: FfmpegProcessT[] = [];
  private configured = false;
  private alphaBuffer: Buffer | null = null;
  private frameSizeBytes = 0;
  private stopInProgress = false;

  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    const logger = getBridgeContext().logger;
    if (config.outputKey === "video_sdi") {
      if (!config.targets.output1Id) {
        throw new Error("Output 1 is required for video SDI");
      }
      const deviceName = await this.resolveDeviceName(config.targets.output1Id);
      this.processes.push(
        this.spawnProcess(config, deviceName, "fill")
      );
      await this.awaitReady();
      this.configured = true;
      logger.info(
        `[GraphicsOutput] SDI video output configured (${config.targets.output1Id} -> ${deviceName})`
      );
      return;
    }

    if (config.outputKey === "key_fill_sdi") {
      if (!config.targets.output1Id || !config.targets.output2Id) {
        throw new Error("Output 1 and Output 2 are required for key/fill SDI");
      }
      const fillDeviceName = await this.resolveDeviceName(
        config.targets.output1Id
      );
      const keyDeviceName = await this.resolveDeviceName(
        config.targets.output2Id
      );
      this.processes.push(
        this.spawnProcess(config, fillDeviceName, "fill"),
        this.spawnProcess(config, keyDeviceName, "key")
      );
      await this.awaitReady();
      this.configured = true;
      logger.info(
        `[GraphicsOutput] SDI key/fill configured (fill: ${config.targets.output1Id} -> ${fillDeviceName}, key: ${config.targets.output2Id} -> ${keyDeviceName})`
      );
      return;
    }

    logger.warn(
      `[GraphicsOutput] Unsupported outputKey for FFmpeg SDI adapter: ${config.outputKey}`
    );
  }

  /**
   * Resolve device ID to device name for FFmpeg
   *
   * FFmpeg requires the device display name, not our internal ID.
   */
  private async resolveDeviceName(deviceId: string): Promise<string> {
    const devices = await deviceCache.getDevices(false);
    const device = devices.find((d) => d.id === deviceId);

    if (!device) {
      throw new Error(`Device not found: ${deviceId}`);
    }

    // FFmpeg expects the displayName (device name from FFmpeg list_devices)
    return device.displayName;
  }

  async sendFrame(
    frame: GraphicsOutputFrameT,
    config: GraphicsOutputConfigT
  ): Promise<void> {
    if (!this.configured || this.processes.length === 0) {
      return;
    }
    if (this.stopInProgress) {
      return;
    }

    if (config.outputKey === "video_sdi") {
      const fillProcess = this.processes.find((proc) => proc.kind === "fill");
      if (!fillProcess || !fillProcess.alive) {
        return;
      }
      writeFrameBestEffort(fillProcess, frame.rgba);
      return;
    }

    if (config.outputKey === "key_fill_sdi") {
      const fillProcess = this.processes.find((proc) => proc.kind === "fill");
      const keyProcess = this.processes.find((proc) => proc.kind === "key");
      if (!fillProcess || !keyProcess) {
        return;
      }
      if (!fillProcess.alive || !keyProcess.alive) {
        return;
      }
      if (this.alphaBuffer && this.frameSizeBytes === frame.rgba.length) {
        fillAlphaChannel(frame.rgba, this.alphaBuffer);
      } else {
        this.frameSizeBytes = frame.rgba.length;
        this.alphaBuffer = Buffer.alloc(Math.floor(frame.rgba.length / 4));
        fillAlphaChannel(frame.rgba, this.alphaBuffer);
      }

      writeFrameBestEffort(fillProcess, frame.rgba);
      writeFrameBestEffort(keyProcess, this.alphaBuffer);
    }
  }

  async stop(): Promise<void> {
    this.stopInProgress = true;
    if (this.processes.length === 0) {
      this.configured = false;
      this.stopInProgress = false;
      return;
    }

    for (const entry of this.processes) {
      entry.process.stdin.end();
      entry.process.kill("SIGTERM");
    }

    await Promise.all(
      this.processes.map((entry) => this.waitForExit(entry))
    );

    this.processes = [];
    this.configured = false;
    this.stopInProgress = false;
  }

  private spawnProcess(
    config: GraphicsOutputConfigT,
    target: string,
    kind: "fill" | "key"
  ): FfmpegProcessT {
    const logger = getBridgeContext().logger;
    const ffmpegPath = resolveFfmpegPath();
    const args =
      kind === "key"
        ? buildKeyArgs(config, target)
        : buildVideoArgs(config, target);

    const process = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const entry: FfmpegProcessT = {
      process,
      target,
      kind,
      alive: true,
      backpressure: false,
      pendingFrame: null,
      ready: this.waitForReady(process, kind),
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
        logger.info(`[GraphicsOutput:${kind}] ${text}`);
      }
    });

    process.stderr.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        logger.error(`[GraphicsOutput:${kind}] ${text}`);
      }
    });

    process.on("error", (error) => {
      entry.alive = false;
      logger.error(`[GraphicsOutput:${kind}] ${error.message}`);
    });

    process.on("exit", (code, signal) => {
      entry.alive = false;
      logger.warn(
        `[GraphicsOutput:${kind}] FFmpeg exited (code=${code}, signal=${signal})`
      );
    });

    return entry;
  }

  private async awaitReady(): Promise<void> {
    try {
      await Promise.all(this.processes.map((entry) => entry.ready));
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private waitForReady(
    process: ChildProcessWithoutNullStreams,
    kind: "fill" | "key"
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 500);

      const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeoutId);
        reject(
          new Error(
            `FFmpeg ${kind} exited during startup (code=${code}, signal=${signal})`
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

  private async waitForExit(entry: FfmpegProcessT): Promise<void> {
    if (entry.process.exitCode !== null) {
      return;
    }

    try {
      await Promise.race([
        once(entry.process, "exit").then(() => undefined),
        new Promise<void>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timeout waiting for FFmpeg")), 2000);
        }),
      ]);
    } catch {
      entry.process.kill("SIGKILL");
      await once(entry.process, "exit").catch(() => undefined);
    }
  }
}
