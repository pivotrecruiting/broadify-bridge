import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
  HelperLifecycleEventT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { getBridgeContext } from "../../bridge-context.js";
import { deviceCache } from "../../device-cache.js";
import type { DeviceDescriptorT } from "@broadify/protocol";
import { resolveDisplayHelperPath } from "../../../modules/display/display-helper.js";
import { displayTargetRegistry } from "../../../modules/display/display-target-registry.js";
import { OUTPUT_DEVICE_MODULE_NAMES } from "../../output-device-modules.js";
import { HelperProcessSession } from "./helper-process-session.js";

type OutputPortMatchT = {
  device: DeviceDescriptorT;
  port: DeviceDescriptorT["ports"][number];
};

const normalizeNativeFrameRate = (fps: number): number =>
  Math.min(240, Math.max(1, Math.round(fps)));

/**
 * Display output adapter for HDMI/DisplayPort/Thunderbolt screens.
 *
 * Streams raw RGBA frames to fullscreen via the native C++ SDL2 helper (FrameBus).
 */
export class DisplayVideoOutputAdapter implements GraphicsOutputAdapter {
  private session: HelperProcessSession | null = null;
  private lifecycleListeners = new Set<(event: HelperLifecycleEventT) => void>();

  async configure(config: GraphicsOutputConfigT): Promise<void> {
    await this.stop();

    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("Display output is only supported on macOS and Windows");
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
    const helperAccessMode =
      process.platform === "win32" ? constants.F_OK : constants.X_OK;
    try {
      await access(helperPath, helperAccessMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Display helper binary not found or inaccessible: ${message}`);
    }

    const frameBusName = process.env.BRIDGE_FRAMEBUS_NAME;
    if (!frameBusName) {
      throw new Error("Native display helper requires BRIDGE_FRAMEBUS_NAME");
    }
    const nativeFrameRate = normalizeNativeFrameRate(config.format.fps);
    const nativeSelector =
      process.platform === "win32"
        ? displayTargetRegistry.resolve(match.port.id)
        : null;
    if (process.platform === "win32" && !nativeSelector) {
      throw new Error(
        `Native Windows display selector missing for ${match.port.id}`,
      );
    }

    const args = [
      "--framebus-name",
      frameBusName,
      "--width",
      String(config.format.width),
      "--height",
      String(config.format.height),
      "--fps",
      String(nativeFrameRate),
      "--display-index",
      "0",
    ];
    if (nativeSelector) {
      args.push("--display-device-name", nativeSelector.deviceName);
    }

    const env = { ...process.env } as Record<string, string>;
    env.BRIDGE_FRAMEBUS_NAME = frameBusName;
    env.BRIDGE_FRAME_WIDTH = String(config.format.width);
    env.BRIDGE_FRAME_HEIGHT = String(config.format.height);
    env.BRIDGE_FRAME_FPS = String(nativeFrameRate);
    if (process.env.BRIDGE_FRAMEBUS_SIZE) {
      env.BRIDGE_FRAMEBUS_SIZE = process.env.BRIDGE_FRAMEBUS_SIZE;
    }
    env.BRIDGE_DISPLAY_MATCH_NAME = match.device.displayName;
    const matchMode = match.port.capabilities.modes?.[0];
    if (matchMode?.width && matchMode?.height) {
      env.BRIDGE_DISPLAY_MATCH_WIDTH = String(matchMode.width);
      env.BRIDGE_DISPLAY_MATCH_HEIGHT = String(matchMode.height);
    }

    this.session = new HelperProcessSession({
      label: "DisplayOutput",
      helperPath,
      args,
      env,
      stdin: "ignore",
      readyTimeoutMs: 8_000,
      stopStrategy: { gracefulMs: 2000, forceMs: 2000 },
      logger: this.getLogger(),
    });
    this.session.onLifecycle((event) => this.emitLifecycle(event));
    await this.session.start();
  }

  async sendFrame(
    _frame: GraphicsOutputFrameT,
    _config: GraphicsOutputConfigT
  ): Promise<void> {
    // FrameBus is always used; helpers read from shared memory. No-op.
  }

  async stop(): Promise<void> {
    await this.session?.stop();
    this.session = null;
  }

  private async findOutputPort(
    portId: string
  ): Promise<OutputPortMatchT | null> {
    const devices = await deviceCache.getDevices(
      false,
      OUTPUT_DEVICE_MODULE_NAMES,
    );
    for (const device of devices) {
      const port = device.ports.find((entry) => entry.id === portId);
      if (port) {
        return { device, port };
      }
    }
    return null;
  }

  onLifecycle(cb: (event: HelperLifecycleEventT) => void): () => void {
    this.lifecycleListeners.add(cb);
    return () => {
      this.lifecycleListeners.delete(cb);
    };
  }

  private emitLifecycle(event: HelperLifecycleEventT): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }

  private getLogger() {
    return getBridgeContext().logger;
  }
}
