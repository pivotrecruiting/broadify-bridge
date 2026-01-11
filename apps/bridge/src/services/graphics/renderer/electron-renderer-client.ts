import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { GraphicsLayoutT } from "../graphics-schemas.js";
import type {
  GraphicsFrameT,
  GraphicsRenderer,
  GraphicsRenderLayerInputT,
} from "./graphics-renderer.js";

const ELECTRON_BINARIES = {
  win32: "electron.cmd",
  default: "electron",
};

function resolveElectronBinary(): string | null {
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
}

function resolveRendererEntry(): string | null {
  const distEntry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "renderer",
    "electron-renderer-entry.js"
  );
  if (fs.existsSync(distEntry)) {
    return distEntry;
  }

  return null;
}

/**
 * Electron-based offscreen renderer client.
 */
export class ElectronRendererClient implements GraphicsRenderer {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private frameCallback: ((frame: GraphicsFrameT) => void) | null = null;
  private ipcServer: net.Server | null = null;
  private ipcSocket: net.Socket | null = null;
  private ipcBuffer = Buffer.alloc(0);

  async initialize(): Promise<void> {
    if (this.child) {
      return;
    }

    const electronBinary = resolveElectronBinary();
    if (!electronBinary) {
      throw new Error("Electron binary not found for graphics renderer");
    }

    const entry = resolveRendererEntry();
    if (!entry) {
      throw new Error("Electron renderer entry not found");
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    const ipcPort = await this.startIpcServer();

    console.log(
      `[GraphicsRenderer] Spawning: ${electronBinary} --graphics-renderer --renderer-entry ${entry}`
    );

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.BRIDGE_GRAPHICS_IPC_PORT = String(ipcPort);

    this.child = spawn(
      electronBinary,
      ["--graphics-renderer", "--renderer-entry", entry],
      {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env,
      }
    );

    this.child.stdout?.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        console.log(`[GraphicsRenderer stdout] ${text}`);
      }
      if (
        text.includes("Electron renderer ready") &&
        this.readyResolver
      ) {
        this.readyResolver();
        this.readyResolver = null;
        this.readyRejecter = null;
      }
    });

    this.child.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        console.error(`[GraphicsRenderer stderr] ${text}`);
      }
    });

    this.child.on("message", (message: unknown) => {
      if (!message || typeof message !== "object") {
        return;
      }
      const msg = message as { type?: string; [key: string]: unknown };
      console.log(`[GraphicsRenderer ipc] ${JSON.stringify(msg)}`);
      if (msg.type === "ready") {
        if (this.readyResolver) {
          this.readyResolver();
          this.readyResolver = null;
          this.readyRejecter = null;
        }
      }
      if (msg.type === "frame" && this.frameCallback) {
        const frame: GraphicsFrameT = {
          layerId: msg.layerId as string,
          width: msg.width as number,
          height: msg.height as number,
          buffer: msg.buffer as Buffer,
          timestamp: msg.timestamp as number,
        };
        this.frameCallback(frame);
      }
      if (msg.type === "error") {
        console.error(`[GraphicsRenderer] ${msg.message as string}`);
      }
    });

    this.child.on("error", (error) => {
      if (this.readyRejecter) {
        this.readyRejecter(error);
        this.readyRejecter = null;
        this.readyResolver = null;
      }
    });

    this.child.on("exit", (code, signal) => {
      if (this.readyRejecter) {
        this.readyRejecter(
          new Error(
            `Graphics renderer exited before ready (code ${code}, signal ${signal})`
          )
        );
        this.readyRejecter = null;
        this.readyResolver = null;
      }
      this.child = null;
    });

    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      const timeoutId = setTimeout(() => {
        if (this.child) {
          this.child.kill();
        }
        reject(new Error("Graphics renderer startup timed out"));
      }, 5000);

      this.readyPromise
        ?.then(() => clearTimeout(timeoutId))
        .catch(() => clearTimeout(timeoutId));
    });

    await Promise.race([this.readyPromise, timeoutPromise]);
  }

  async setAssets(
    assets: Record<string, { filePath: string; mime: string }>
  ): Promise<void> {
    if (!this.child) {
      return;
    }
    await this.readyPromise;
    this.sendCommand({ type: "set_assets", assets });
  }

  async renderLayer(input: GraphicsRenderLayerInputT): Promise<void> {
    await this.ensureReady();
    this.sendCommand({
      type: "create_layer",
      layerId: input.layerId,
      html: input.html,
      css: input.css,
      values: input.values,
      layout: input.layout,
      backgroundMode: input.backgroundMode,
      width: input.width,
      height: input.height,
      fps: input.fps,
    });
  }

  async updateValues(layerId: string, values: Record<string, unknown>): Promise<void> {
    await this.ensureReady();
    this.sendCommand({ type: "update_values", layerId, values });
  }

  async updateLayout(layerId: string, layout: GraphicsLayoutT): Promise<void> {
    await this.ensureReady();
    this.sendCommand({ type: "update_layout", layerId, layout });
  }

  async removeLayer(layerId: string): Promise<void> {
    await this.ensureReady();
    this.sendCommand({ type: "remove_layer", layerId });
  }

  onFrame(callback: (frame: GraphicsFrameT) => void): void {
    this.frameCallback = callback;
  }

  async shutdown(): Promise<void> {
    if (!this.child) {
      return;
    }
    this.sendCommand({ type: "shutdown" });
    this.child = null;
    this.ipcSocket?.destroy();
    this.ipcSocket = null;
    await this.stopIpcServer();
  }

  private async ensureReady(): Promise<void> {
    if (!this.child) {
      await this.initialize();
      return;
    }
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }

  private async startIpcServer(): Promise<number> {
    if (this.ipcServer) {
      return 0;
    }

    this.ipcServer = net.createServer((socket) => {
      this.ipcSocket = socket;
      console.log("[GraphicsRenderer IPC] Client connected");
      socket.on("data", (data) => this.handleIpcData(data));
      socket.on("close", () => {
        console.warn("[GraphicsRenderer IPC] Client disconnected");
        this.ipcSocket = null;
      });
      socket.on("error", (error) => {
        console.error(`[GraphicsRenderer IPC] ${error.message}`);
      });
    });

    return new Promise((resolve, reject) => {
      this.ipcServer?.listen(0, "127.0.0.1", () => {
        const address = this.ipcServer?.address();
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Failed to allocate IPC port"));
      });
    });
  }

  private async stopIpcServer(): Promise<void> {
    if (!this.ipcServer) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.ipcServer?.close(() => resolve());
    });
    this.ipcServer = null;
  }

  private handleIpcData(data: Buffer): void {
    this.ipcBuffer = Buffer.concat([this.ipcBuffer, data]);

    while (this.ipcBuffer.length >= 4) {
      const headerLength = this.ipcBuffer.readUInt32BE(0);
      if (this.ipcBuffer.length < 4 + headerLength) {
        return;
      }

      const headerRaw = this.ipcBuffer.subarray(4, 4 + headerLength);
      let header: {
        type: string;
        bufferLength?: number;
        [key: string]: unknown;
      };
      try {
        header = JSON.parse(headerRaw.toString("utf-8")) as {
          type: string;
          bufferLength?: number;
          [key: string]: unknown;
        };
      } catch {
        this.ipcBuffer = Buffer.alloc(0);
        return;
      }

      const bufferLength = header.bufferLength || 0;
      const totalLength = 4 + headerLength + bufferLength;
      if (this.ipcBuffer.length < totalLength) {
        return;
      }

      let payloadBuffer: Buffer | null = null;
      if (bufferLength > 0) {
        payloadBuffer = this.ipcBuffer.subarray(4 + headerLength, totalLength);
      }

      this.ipcBuffer = this.ipcBuffer.subarray(totalLength);

      if (header.type === "ready" && this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
        this.readyRejecter = null;
      }

      if (header.type === "frame" && payloadBuffer && this.frameCallback) {
        const frame: GraphicsFrameT = {
          layerId: String(header.layerId || ""),
          width: Number(header.width || 0),
          height: Number(header.height || 0),
          buffer: payloadBuffer,
          timestamp: Number(header.timestamp || Date.now()),
        };
        this.frameCallback(frame);
      }
    }
  }

  private sendCommand(message: Record<string, unknown>): void {
    if (this.ipcSocket) {
      const header = Buffer.from(JSON.stringify(message), "utf-8");
      const headerLength = Buffer.alloc(4);
      headerLength.writeUInt32BE(header.length, 0);
      this.ipcSocket.write(Buffer.concat([headerLength, header]));
      return;
    }

    if (this.child) {
      this.child.send(message);
    }
  }
}
