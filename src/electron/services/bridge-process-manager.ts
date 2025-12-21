import { ChildProcess, spawn } from "child_process";
import { app } from "electron";
import path from "path";
import { isDev } from "../util.js";
import type { BridgeConfig } from "../../../types.js";

/**
 * Bridge process manager
 * Handles starting, stopping, and monitoring the bridge process
 */
export class BridgeProcessManager {
  private bridgeProcess: ChildProcess | null = null;
  private config: BridgeConfig | null = null;

  /**
   * Start the bridge process with given configuration
   */
  async start(config: BridgeConfig): Promise<{ success: boolean; error?: string }> {
    // If already running, stop first
    if (this.bridgeProcess) {
      await this.stop();
    }

    try {
      this.config = config;

      // Determine bridge entry point and arguments
      const bridgePath = this.getBridgePath();
      const args = this.getBridgeArgs(config);

      // Spawn bridge process
      this.bridgeProcess = spawn(bridgePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: isDev() ? path.join(app.getAppPath(), "apps/bridge") : undefined,
        env: {
          ...process.env,
          NODE_ENV: isDev() ? "development" : "production",
        },
      });

      // Handle process events
      this.bridgeProcess.on("error", (error) => {
        console.error("Bridge process error:", error);
      });

      this.bridgeProcess.on("exit", (code, signal) => {
        console.log(`Bridge process exited with code ${code} and signal ${signal}`);
        this.bridgeProcess = null;
      });

      // Forward stdout/stderr for debugging
      if (this.bridgeProcess.stdout) {
        this.bridgeProcess.stdout.on("data", (data) => {
          console.log(`[Bridge] ${data.toString().trim()}`);
        });
      }

      if (this.bridgeProcess.stderr) {
        this.bridgeProcess.stderr.on("data", (data) => {
          console.error(`[Bridge Error] ${data.toString().trim()}`);
        });
      }

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Stop the bridge process
   */
  async stop(): Promise<{ success: boolean; error?: string }> {
    if (!this.bridgeProcess) {
      return { success: true };
    }

    try {
      // Send SIGTERM for graceful shutdown
      this.bridgeProcess.kill("SIGTERM");

      // Wait for process to exit (max 5 seconds)
      await new Promise<void>((resolve, reject) => {
        if (!this.bridgeProcess) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          // Force kill if still running
          if (this.bridgeProcess) {
            this.bridgeProcess.kill("SIGKILL");
          }
          reject(new Error("Bridge process did not exit in time"));
        }, 5000);

        this.bridgeProcess.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.bridgeProcess = null;
      this.config = null;

      return { success: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Check if bridge process is running
   */
  isRunning(): boolean {
    return this.bridgeProcess !== null && !this.bridgeProcess.killed;
  }

  /**
   * Get current bridge configuration
   */
  getConfig(): BridgeConfig | null {
    return this.config;
  }

  /**
   * Get bridge executable path
   */
  private getBridgePath(): string {
    if (isDev()) {
      // Development: use npx to run tsx
      return "npx";
    } else {
      // Production: use node to run compiled JavaScript
      return "node";
    }
  }

  /**
   * Get bridge arguments
   */
  private getBridgeArgs(config: BridgeConfig): string[] {
    if (isDev()) {
      // Development: npx tsx src/index.ts --host ... --port ...
      return [
        "tsx",
        path.join(app.getAppPath(), "apps/bridge/src/index.ts"),
        "--host",
        config.host,
        "--port",
        config.port.toString(),
      ];
    } else {
      // Production: node dist/index.js --host ... --port ...
      const appPath = app.getAppPath();
      return [
        path.join(appPath, "../apps/bridge/dist/index.js"),
        "--host",
        config.host,
        "--port",
        config.port.toString(),
      ];
    }
  }
}

// Singleton instance
export const bridgeProcessManager = new BridgeProcessManager();

