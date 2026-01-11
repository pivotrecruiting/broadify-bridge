import { spawn, type ChildProcess } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type {
  GraphicsOutputAdapter,
  GraphicsOutputFrameT,
} from "../output-adapter.js";
import type { GraphicsOutputConfigT } from "../graphics-schemas.js";
import { getBridgeContext } from "../../bridge-context.js";
import { resolveDecklinkHelperPath } from "../../../modules/decklink/decklink-helper.js";

type DecklinkPortInfo = {
  deviceId: string;
  portType: "sdi" | "hdmi";
  portRole: "fill" | "key" | "video";
};

const FRAME_MAGIC = 0x42524746; // 'BRGF'
const FRAME_VERSION = 1;
const FRAME_TYPE_FRAME = 1;
const FRAME_TYPE_SHUTDOWN = 2;
const FRAME_HEADER_LENGTH = 28;

function parseDecklinkPortId(portId: string): DecklinkPortInfo | null {
  if (portId.endsWith("-sdi-a")) {
    return {
      deviceId: portId.slice(0, -"-sdi-a".length),
      portType: "sdi",
      portRole: "fill",
    };
  }
  if (portId.endsWith("-sdi-b")) {
    return {
      deviceId: portId.slice(0, -"-sdi-b".length),
      portType: "sdi",
      portRole: "key",
    };
  }
  if (portId.endsWith("-sdi")) {
    return {
      deviceId: portId.slice(0, -"-sdi".length),
      portType: "sdi",
      portRole: "video",
    };
  }
  if (portId.endsWith("-hdmi")) {
    return {
      deviceId: portId.slice(0, -"-hdmi".length),
      portType: "hdmi",
      portRole: "video",
    };
  }
  return null;
}

/**
 * DeckLink output adapter for external keying (SDI fill + key).
 */
export class DecklinkKeyFillOutputAdapter implements GraphicsOutputAdapter {
  private child: ChildProcess | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private stdoutBuffer = "";
  private canSend = true;
  private width = 0;
  private height = 0;

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
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    this.child = spawn(
      helperPath,
      [
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
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    this.child.stdout?.on("data", (data) => this.handleStdout(data));
    this.child.stderr?.on("data", (data) => {
      const text = data.toString().trim();
      if (text.length > 0) {
        this.getLogger().warn(`[DeckLinkOutput] ${text}`);
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
            `DeckLink output helper exited before ready (code ${code}, signal ${signal})`
          )
        );
      }
      this.readyRejecter = null;
      this.readyResolver = null;
      this.child = null;
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
      return;
    }
    if (this.readyPromise) {
      try {
        await this.readyPromise;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.getLogger().warn(`[DeckLinkOutput] Not ready: ${message}`);
        return;
      }
    }

    if (!this.canSend) {
      return;
    }

    if (this.width && this.height) {
      if (frame.width !== this.width || frame.height !== this.height) {
        return;
      }
    }

    const expectedLength = frame.width * frame.height * 4;
    if (frame.rgba.length !== expectedLength) {
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

  private handleStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString("utf-8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf("\n");

      if (!line) {
        continue;
      }

      try {
        const message = JSON.parse(line) as { type?: string };
        if (message.type === "ready" && this.readyResolver) {
          this.readyResolver();
          this.readyResolver = null;
          this.readyRejecter = null;
        }
      } catch {
        this.getLogger().warn(`[DeckLinkOutput] Non-JSON output: ${line}`);
      }
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
