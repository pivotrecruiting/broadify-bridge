import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { getBridgeContext } from "../../bridge-context.js";
import { deviceCache } from "../../device-cache.js";
import type { DeviceDescriptorT } from "@broadify/protocol";
import { resolveDisplayHelperPath } from "../../../modules/display/display-helper.js";

type OutputPortMatchT = {
  device: DeviceDescriptorT;
  port: DeviceDescriptorT["ports"][number];
};

/**
 * Display output adapter for HDMI/DisplayPort/Thunderbolt screens.
 *
 * Streams raw RGBA frames to fullscreen via the native C++ SDL2 helper (FrameBus).
 */
export class DisplayVideoOutputAdapter implements GraphicsOutputAdapter {
  private child: ChildProcess | null = null;
  // Handshake promise resolved when helper signals readiness via stdout JSON.
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private stdoutBuffer = "";

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

    await this.configureNativeHelper(config, match);
  }

  /**
   * Configure and start the native C++ Display Helper (FrameBus).
   */
  private async configureNativeHelper(
    config: GraphicsOutputConfigT,
    match: OutputPortMatchT
  ): Promise<void> {
    const helperPath = resolveDisplayHelperPath();
    try {
      await access(helperPath, constants.X_OK);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Display helper binary not found or not executable: ${message}`);
    }

    const frameBusName = process.env.BRIDGE_FRAMEBUS_NAME;
    if (!frameBusName) {
      throw new Error("Native display helper requires BRIDGE_FRAMEBUS_NAME");
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    const args = [
      "--framebus-name",
      frameBusName,
      "--width",
      String(config.format.width),
      "--height",
      String(config.format.height),
      "--fps",
      String(config.format.fps),
      "--display-index",
      "0",
    ];

    const env = { ...process.env } as Record<string, string>;
    env.BRIDGE_FRAMEBUS_NAME = frameBusName;
    env.BRIDGE_FRAME_WIDTH = String(config.format.width);
    env.BRIDGE_FRAME_HEIGHT = String(config.format.height);
    env.BRIDGE_FRAME_FPS = String(config.format.fps);
    if (process.env.BRIDGE_FRAMEBUS_SIZE) {
      env.BRIDGE_FRAMEBUS_SIZE = process.env.BRIDGE_FRAMEBUS_SIZE;
    }
    env.BRIDGE_DISPLAY_MATCH_NAME = match.device.displayName;

    this.child = spawn(helperPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });

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
            `Display helper exited before ready (code ${code}, signal ${signal})`
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
  }

  async sendFrame(
    _frame: GraphicsOutputFrameT,
    _config: GraphicsOutputConfigT
  ): Promise<void> {
    // FrameBus is always used; helpers read from shared memory. No-op.
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    const child = this.child;
    const hasExited = () =>
      child.exitCode !== null || child.signalCode !== null;
    const awaitExit = () =>
      new Promise<void>((resolve) => {
        if (hasExited()) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
      });

    const gracefulTimeoutMs = 4000;
    const forceTimeoutMs = 2000;

    await Promise.race([
      awaitExit(),
      new Promise<void>((resolve) => {
        const timeoutId = setTimeout(() => resolve(), gracefulTimeoutMs);
        void awaitExit().then(() => clearTimeout(timeoutId));
      }),
    ]);

    if (!hasExited()) {
      child.kill("SIGTERM");
      await Promise.race([
        awaitExit(),
        new Promise<void>((resolve) => {
          const timeoutId = setTimeout(() => resolve(), forceTimeoutMs);
          void awaitExit().then(() => clearTimeout(timeoutId));
        }),
      ]);
    }

    if (!hasExited()) {
      child.kill("SIGKILL");
      await awaitExit();
    }

    this.child = null;
    this.readyPromise = null;
    this.readyResolver = null;
    this.readyRejecter = null;
    this.stdoutBuffer = "";
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
        } else if (message.type === "metrics") {
          this.getLogger().debug?.(`[DisplayOutput] ${line}`);
        } else {
          this.getLogger().debug?.(`[DisplayOutput] ${line}`);
        }
      } catch {
        this.getLogger().warn(`[DisplayOutput] Non-JSON output: ${line}`);
      }
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private getLogger() {
    return getBridgeContext().logger;
  }
}
