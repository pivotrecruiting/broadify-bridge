import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resolveElectronBinary } from "../graphics/renderer/electron-renderer-launch.js";
import { DEFAULT_MEETING_FRAMEBUS_NAME } from "../../modules/vcam/vcam-helper.js";

/**
 * Conference display output: shows the composed meeting program frame fullscreen
 * on a physical display (HDMI/DisplayProt), which a capture device downstream
 * presents to a Teams/Zoom Room as a USB camera. It spawns the self-contained
 * Electron display window (`display-output-entry.js`), which reads the meeting
 * FrameBus directly in its main process and renders it fullscreen.
 */

const READY_TIMEOUT_MS = 12000;

export type ConferenceDisplayTargetT = {
  /** Substring match against the display label (empty = auto external display). */
  matchName?: string;
  matchWidth?: number;
  matchHeight?: number;
};

export type ConferenceDisplayStatusT = {
  running: boolean;
  frameBusName: string;
  target: ConferenceDisplayTargetT;
  lastError: string | null;
};

const resolveDisplayEntry = (): string | null => {
  const entry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "display",
    "display-output-entry.js",
  );
  return fs.existsSync(entry) ? entry : null;
};

const resolveDisplayPreload = (): string | null => {
  const preload = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "display",
    "display-output-preload.cjs",
  );
  return fs.existsSync(preload) ? preload : null;
};

export class ConferenceDisplayOutput {
  private child: ChildProcess | null = null;
  private target: ConferenceDisplayTargetT = {};
  private lastError: string | null = null;
  private stopping = false;
  private readonly frameBusName: string;

  constructor(frameBusName: string = DEFAULT_MEETING_FRAMEBUS_NAME) {
    this.frameBusName = frameBusName;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  status(): ConferenceDisplayStatusT {
    return {
      running: this.isRunning(),
      frameBusName: this.frameBusName,
      target: this.target,
      lastError: this.lastError,
    };
  }

  /**
   * Starts the fullscreen display window. Idempotent: if already running with a
   * different target, it restarts on the new target. Resolves once the window
   * reports ready (or rejects on spawn/ready failure).
   */
  async start(target: ConferenceDisplayTargetT = {}): Promise<void> {
    if (this.child) {
      await this.stop();
    }

    const electronBinary = resolveElectronBinary();
    if (!electronBinary) {
      throw new Error("Electron binary not found for conference display output");
    }
    const entry = resolveDisplayEntry();
    if (!entry) {
      throw new Error("Conference display entry not found (build required)");
    }
    const preload = resolveDisplayPreload();
    if (!preload) {
      throw new Error("Conference display preload not found (build required)");
    }

    this.target = target;
    this.lastError = null;

    const env = { ...process.env } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    env.BRIDGE_PARENT_PID = String(process.pid);
    env.BRIDGE_FRAMEBUS_NAME = this.frameBusName;
    env.BRIDGE_DISPLAY_PRELOAD = preload;
    if (target.matchName) {
      env.BRIDGE_DISPLAY_MATCH_NAME = target.matchName;
    }
    if (target.matchWidth && target.matchWidth > 0) {
      env.BRIDGE_DISPLAY_MATCH_WIDTH = String(target.matchWidth);
    }
    if (target.matchHeight && target.matchHeight > 0) {
      env.BRIDGE_DISPLAY_MATCH_HEIGHT = String(target.matchHeight);
    }

    const child = spawn(electronBinary, [entry], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    this.child = child;

    const ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        if (error) reject(error);
        else resolve();
      };

      const timeoutId = setTimeout(() => {
        finish(new Error("Conference display output startup timed out"));
      }, READY_TIMEOUT_MS);

      let stdoutBuffer = "";
      child.stdout?.on("data", (data: Buffer) => {
        stdoutBuffer += data.toString();
        let newlineIndex = stdoutBuffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = stdoutBuffer.slice(0, newlineIndex).trim();
          stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
          if (line.includes('"type":"ready"')) {
            finish();
          }
          newlineIndex = stdoutBuffer.indexOf("\n");
        }
      });

      child.on("error", (error) => {
        this.lastError = error.message;
        finish(error);
      });

      child.on("exit", (code, signal) => {
        if (this.child === child) {
          this.child = null;
        }
        // An exit during an intentional stop, or a clean exit(0), is not an
        // error — only record unexpected terminations.
        if (!this.stopping && code !== 0) {
          this.lastError = `Conference display output exited (code ${code}, signal ${signal})`;
        }
        finish(new Error(`exited (code ${code}, signal ${signal})`));
      });
    });

    try {
      await ready;
    } catch (error) {
      // Ensure a failed start leaves no orphaned process behind.
      if (this.child === child) {
        this.child = null;
      }
      child.kill();
      throw error;
    }
  }

  /** Stops the display window if running. Idempotent. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.child = null;
    this.stopping = true;
    this.lastError = null;
    await new Promise<void>((resolve) => {
      const timeoutId = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.once("exit", () => {
        clearTimeout(timeoutId);
        resolve();
      });
      child.kill();
    });
    this.stopping = false;
  }
}
