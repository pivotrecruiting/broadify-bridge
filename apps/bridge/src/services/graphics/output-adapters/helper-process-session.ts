import { spawn, type ChildProcess } from "node:child_process";
import type { LoggerLikeT } from "../../bridge-context.js";
import { stopChildProcessWithEscalation } from "../../shared/child-process-exit.js";

export type HelperLifecycleEventT =
  | { type: "playback_started" }
  | { type: "fatal"; code: string; message: string }
  | {
      type: "exited";
      code: number | null;
      signal: NodeJS.Signals | null;
      requested: boolean;
      lastStderr: string[];
      fatal?: { code: string; message: string };
    };

export type HelperProcessSessionOptionsT = {
  label: string;
  helperPath: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: "pipe" | "ignore";
  readyTimeoutMs: number;
  stderrRingSize?: number;
  stderrLogLevel?: "warn" | "error";
  logUnknownMessages?: boolean;
  stopStrategy: {
    shutdownHeader?: Buffer;
    gracefulMs: number;
    forceMs: number;
  };
  logger: LoggerLikeT;
};

export class HelperProcessSession {
  private child: ChildProcess | null = null;
  private stdoutBuffer = "";
  private stderrRing: string[] = [];
  private lifecycleListeners = new Set<(event: HelperLifecycleEventT) => void>();
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: Error) => void) | null = null;
  private readySettled = false;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private requestedStop = false;
  private lastFatal: { code: string; message: string } | undefined;
  private version: string | null = null;

  constructor(private readonly options: HelperProcessSessionOptionsT) {}

  get helperVersion(): string | null {
    return this.version;
  }

  start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error(`${this.options.label} already started`));
    }
    this.requestedStop = false;
    this.readySettled = false;
    this.stdoutBuffer = "";
    this.stderrRing = [];
    this.lastFatal = undefined;
    this.version = null;

    const child = spawn(this.options.helperPath, this.options.args, {
      stdio: [this.options.stdin, "pipe", "pipe"],
      env: this.options.env,
    });
    this.child = child;

    child.stdout?.on("data", (data) => this.handleStdout(data));
    child.stderr?.on("data", (data) => this.handleStderr(data));
    child.on("error", (error) => {
      this.rejectReady(error);
    });
    child.on("exit", (code, signal) => {
      this.handleExit(code, signal);
    });

    this.readyTimer = setTimeout(() => {
      this.rejectReady(
        new Error(
          `${this.options.label} helper timed out after ${this.options.readyTimeoutMs}ms before ready${this.formatFailureContext()}`,
        ),
      );
      try {
        child.kill("SIGKILL");
      } catch {
        // The process may already be gone; the rejection above is bounded.
      }
    }, this.options.readyTimeoutMs);
    this.readyTimer.unref?.();

    return new Promise((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) {
      return;
    }
    this.requestedStop = true;
    this.clearReadyTimer();
    this.rejectReady(new Error(`${this.options.label} helper stopped before ready`));
    await stopChildProcessWithEscalation(child, {
      requestShutdown: () => {
        if (this.options.stopStrategy.shutdownHeader && child.stdin) {
          child.stdin.write(this.options.stopStrategy.shutdownHeader);
          child.stdin.end();
          return;
        }
        child.kill("SIGTERM");
      },
      gracefulMs: this.options.stopStrategy.gracefulMs,
      forceMs: this.options.stopStrategy.forceMs,
    });
    this.child = null;
    this.stdoutBuffer = "";
  }

  onLifecycle(cb: (event: HelperLifecycleEventT) => void): () => void {
    this.lifecycleListeners.add(cb);
    return () => {
      this.lifecycleListeners.delete(cb);
    };
  }

  private handleStdout(data: Buffer): void {
    this.stdoutBuffer += data.toString("utf-8");
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (line.length === 0) {
        continue;
      }
      this.handleMessageLine(line);
    }
  }

  private handleMessageLine(line: string): void {
    try {
      const message = JSON.parse(line) as {
        type?: string;
        helperVersion?: unknown;
        code?: unknown;
        message?: unknown;
      };
      if (message.type === "ready") {
        if (typeof message.helperVersion === "string") {
          this.version = message.helperVersion;
        }
        this.resolveReady();
        return;
      }
      if (message.type === "metrics") {
        this.options.logger.debug?.(`[${this.options.label}] ${line}`);
        return;
      }
      if (message.type === "playback_started") {
        this.emit({ type: "playback_started" });
        return;
      }
      if (
        message.type === "fatal" &&
        typeof message.code === "string" &&
        typeof message.message === "string"
      ) {
        this.lastFatal = { code: message.code, message: message.message };
        this.emit({ type: "fatal", ...this.lastFatal });
        return;
      }
      if (this.options.logUnknownMessages !== false) {
        this.options.logger.debug?.(`[${this.options.label}] ${line}`);
      }
    } catch {
      this.options.logger.warn(`[${this.options.label}] Non-JSON output: ${line}`);
    }
  }

  private handleStderr(data: Buffer): void {
    const lines = data
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of lines) {
      this.stderrRing.push(line);
      while (this.stderrRing.length > (this.options.stderrRingSize ?? 20)) {
        this.stderrRing.shift();
      }
      if (this.options.stderrLogLevel === "error") {
        this.options.logger.error(`[${this.options.label}] ${line}`);
      } else {
        this.options.logger.warn(`[${this.options.label}] ${line}`);
      }
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const requested = this.requestedStop;
    const wasReady = this.readySettled;
    if (!this.readySettled) {
      this.rejectReady(
        new Error(
          `${this.options.label} helper exited before ready (code ${code}, signal ${signal})${this.formatFailureContext()}`,
        ),
      );
    }
    this.clearReadyTimer();
    this.child = null;
    this.options.logger.error(
      `[${this.options.label}] Helper exited (code ${code}, signal ${signal})`,
    );
    if (wasReady && !requested) {
      this.emit({
        type: "exited",
        code,
        signal,
        requested,
        lastStderr: [...this.stderrRing],
        ...(this.lastFatal ? { fatal: this.lastFatal } : {}),
      });
    }
  }

  private resolveReady(): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.clearReadyTimer();
    this.readyResolver?.();
    this.readyResolver = null;
    this.readyRejecter = null;
  }

  private rejectReady(error: Error): void {
    if (this.readySettled) {
      return;
    }
    this.readySettled = true;
    this.clearReadyTimer();
    this.readyRejecter?.(error);
    this.readyResolver = null;
    this.readyRejecter = null;
  }

  private clearReadyTimer(): void {
    if (!this.readyTimer) {
      return;
    }
    clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private formatFailureContext(): string {
    const parts: string[] = [];
    if (this.lastFatal) {
      parts.push(`fatal=${this.lastFatal.code}: ${this.lastFatal.message}`);
    }
    if (this.stderrRing.length > 0) {
      parts.push(`stderr=${this.stderrRing.join(" | ")}`);
    }
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  }

  private emit(event: HelperLifecycleEventT): void {
    for (const listener of this.lifecycleListeners) {
      listener(event);
    }
  }
}
