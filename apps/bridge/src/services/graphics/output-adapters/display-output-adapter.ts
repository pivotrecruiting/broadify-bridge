import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { getBridgeContext } from "../../bridge-context.js";
import { deviceCache } from "../../device-cache.js";
import type { DeviceDescriptorT } from "@broadify/protocol";

// Binary frame protocol shared with the helper (big-endian header + RGBA payload).
const FRAME_MAGIC = 0x42524746; // 'BRGF'
const FRAME_VERSION = 1;
const FRAME_TYPE_FRAME = 1;
const FRAME_TYPE_SHUTDOWN = 2;
const FRAME_HEADER_LENGTH = 28;
const MAX_FRAME_DIMENSION = 8192;

// Electron binary resolution for dev/packaged environments.
const ELECTRON_BINARIES = {
  win32: "electron.cmd",
  default: "electron",
};

type OutputPortMatchT = {
  device: DeviceDescriptorT;
  port: DeviceDescriptorT["ports"][number];
};

// Resolve the Electron CLI used to launch the helper.
const resolveElectronBinary = (): string | null => {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return process.execPath;
  }

  if (process.execPath.toLowerCase().includes("electron")) {
    return process.execPath;
  }

  const binaryName =
    process.platform === "win32"
      ? ELECTRON_BINARIES.win32
      : ELECTRON_BINARIES.default;

  const candidate = path.resolve(
    process.cwd(),
    "..",
    "..",
    "node_modules",
    ".bin",
    binaryName
  );

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return null;
};

// Resolve the compiled helper entry in the bridge dist folder.
const resolveDisplayEntry = (): string | null => {
  const distEntry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "display",
    "display-output-entry.js"
  );
  return fs.existsSync(distEntry) ? distEntry : null;
};

// Resolve the compiled preload script for the helper renderer.
const resolveDisplayPreload = (): string | null => {
  const distEntry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "display",
    "display-output-preload.js"
  );
  return fs.existsSync(distEntry) ? distEntry : null;
};

/**
 * Display output adapter for HDMI/DisplayPort/Thunderbolt screens.
 *
 * Streams raw RGBA frames to a fullscreen Electron helper window.
 */
export class DisplayVideoOutputAdapter implements GraphicsOutputAdapter {
  private child: ChildProcess | null = null;
  // Handshake promise resolved when helper signals readiness via stdout JSON.
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private stdoutBuffer = "";
  private canSend = true;
  private width = 0;
  private height = 0;
  private lastWarningAt = 0;
  private readonly warningThrottleMs = 5000;

  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    if (process.platform !== "darwin") {
      throw new Error("Display output is only supported on macOS");
    }

    const output1Id = config.targets.output1Id;
    if (!output1Id) {
      throw new Error("Missing output port for Display video output");
    }

    const match = await this.findOutputPort(output1Id);
    if (!match || match.device.type !== "display") {
      throw new Error("Selected output is not a display device");
    }
    if (
      match.port.type !== "hdmi" &&
      match.port.type !== "displayport" &&
      match.port.type !== "thunderbolt"
    ) {
      throw new Error("Display output requires HDMI/DisplayPort/Thunderbolt");
    }

    const electronBinary = resolveElectronBinary();
    if (!electronBinary) {
      throw new Error("Electron binary not found for display output");
    }

    const entry = resolveDisplayEntry();
    if (!entry) {
      throw new Error("Display output entry not found");
    }

    const preload = resolveDisplayPreload();
    if (!preload) {
      throw new Error("Display output preload not found");
    }

    // Security: verify helper files are readable before spawning a child process.
    try {
      await access(entry, constants.R_OK);
      await access(preload, constants.R_OK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Display output files not readable: ${message}`);
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    // Pass only whitelisted environment values to target display selection.
    const env = { ...process.env } as Record<string, string>;
    env.BRIDGE_DISPLAY_PRELOAD = preload;
    env.BRIDGE_DISPLAY_MATCH_NAME = match.device.displayName;
    env.BRIDGE_DISPLAY_MATCH_PORT_TYPE = match.port.type;
    if (match.port.capabilities.modes?.[0]) {
      env.BRIDGE_DISPLAY_MATCH_WIDTH = String(
        match.port.capabilities.modes[0].width
      );
      env.BRIDGE_DISPLAY_MATCH_HEIGHT = String(
        match.port.capabilities.modes[0].height
      );
    }
    env.BRIDGE_DISPLAY_FRAME_WIDTH = String(config.format.width);
    env.BRIDGE_DISPLAY_FRAME_HEIGHT = String(config.format.height);
    env.BRIDGE_DISPLAY_FRAME_FPS = String(config.format.fps);

    // Security: spawn a fixed Electron entry with controlled args only.
    this.child = spawn(
      electronBinary,
      ["--display-output", "--display-entry", entry],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      }
    );

    this.child.stdout?.on("data", (data) => this.handleStdout(data));
    this.child.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        this.getLogger().warn(`[DisplayOutput] ${text}`);
      }
    });

    this.child.on("error", (error) => {
      if (this.readyRejecter) {
        this.readyRejecter(error);
      }
      this.readyRejecter = null;
      this.readyResolver = null;
    });

    this.child.on("exit", (code, signal) => {
      if (this.readyRejecter) {
        this.readyRejecter(
          new Error(
            `Display output helper exited before ready (code ${code}, signal ${signal})`
          )
        );
      }
      this.readyRejecter = null;
      this.readyResolver = null;
      this.child = null;
      this.getLogger().error(
        `[DisplayOutput] Helper exited (code ${code}, signal ${signal})`
      );
    });

    await this.readyPromise;
    this.width = config.format.width;
    this.height = config.format.height;
  }

  async sendFrame(
    frame: GraphicsOutputFrameT,
    _config: GraphicsOutputConfigT
  ): Promise<void> {
    if (!this.child || !this.child.stdin) {
      this.logThrottledWarning("Display helper not running");
      return;
    }
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.getLogger().warn(`[DisplayOutput] Not ready: ${message}`);
        return;
      }
    }

    if (!this.canSend) {
      return;
    }

    if (
      frame.width > MAX_FRAME_DIMENSION ||
      frame.height > MAX_FRAME_DIMENSION
    ) {
      this.logThrottledWarning("Frame dimensions exceed limit");
      return;
    }

    if (this.width && this.height) {
      if (frame.width !== this.width || frame.height !== this.height) {
        this.logThrottledWarning(
          `Frame size mismatch: ${frame.width}x${frame.height}`
        );
        return;
      }
    }

    const expectedLength = frame.width * frame.height * 4;
    if (frame.rgba.length !== expectedLength) {
      this.logThrottledWarning(
        `Frame buffer length mismatch: ${frame.rgba.length} !== ${expectedLength}`
      );
      return;
    }

    const header = Buffer.alloc(FRAME_HEADER_LENGTH);
    header.writeUInt32BE(FRAME_MAGIC, 0);
    header.writeUInt16BE(FRAME_VERSION, 4);
    header.writeUInt16BE(FRAME_TYPE_FRAME, 6);
    header.writeUInt32BE(frame.width, 8);
    header.writeUInt32BE(frame.height, 12);
    header.writeBigUInt64BE(BigInt(frame.timestamp), 16);
    header.writeUInt32BE(frame.rgba.length, 24);

    const payload = Buffer.concat([header, frame.rgba]);
    const ok = this.child.stdin.write(payload);
    if (!ok) {
      this.canSend = false;
      this.child.stdin.once("drain", () => {
        this.canSend = true;
      });
    }
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const stdin = this.child.stdin;
    if (stdin) {
      const header = Buffer.alloc(FRAME_HEADER_LENGTH);
      header.writeUInt32BE(FRAME_MAGIC, 0);
      header.writeUInt16BE(FRAME_VERSION, 4);
      header.writeUInt16BE(FRAME_TYPE_SHUTDOWN, 6);
      header.writeUInt32BE(0, 8);
      header.writeUInt32BE(0, 12);
      header.writeBigUInt64BE(BigInt(Date.now()), 16);
      header.writeUInt32BE(0, 24);
      stdin.write(header);
      stdin.end();
    }

    this.child.kill("SIGTERM");
    this.child = null;
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejecter = null;
    this.stdoutBuffer = "";
    this.canSend = true;
    this.width = 0;
    this.height = 0;
  }

  private async findOutputPort(
    portId: string
  ): Promise<OutputPortMatchT | null> {
    const devices = await deviceCache.getDevices();
    for (const device of devices) {
      const port = device.ports.find((entry) => entry.id === portId);
      if (port) {
        return { device, port };
      }
    }
    return null;
  }

  private handleStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString("utf-8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        newlineIndex = this.stdoutBuffer.indexOf("\n");
        continue;
      }
      try {
        const message = JSON.parse(line) as { type?: string };
        if (message.type === "ready") {
          if (this.readyResolver) {
            this.readyResolver();
            this.readyResolver = null;
            this.readyRejecter = null;
          }
        } else {
          this.getLogger().info(`[DisplayOutput] ${line}`);
        }
      } catch {
        this.getLogger().warn(`[DisplayOutput] Non-JSON output: ${line}`);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private logThrottledWarning(message: string): void {
    const now = Date.now();
    if (now - this.lastWarningAt > this.warningThrottleMs) {
      this.getLogger().warn(`[DisplayOutput] ${message}`);
      this.lastWarningAt = now;
    }
  }

  private getLogger() {
    return getBridgeContext().logger;
  }
}
