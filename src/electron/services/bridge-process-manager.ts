import { ChildProcess, spawn } from "child_process";
import { app } from "electron";
import path from "path";
import { isDev } from "../util.js";
import type { BridgeConfig } from "../../../types.js";
import { isPortAvailable, findAvailablePort } from "./port-checker.js";

/**
 * Bridge process manager
 * Handles starting, stopping, and monitoring the bridge process
 */
export class BridgeProcessManager {
  private bridgeProcess: ChildProcess | null = null;
  private config: BridgeConfig | null = null;

  /**
   * Start the bridge process with given configuration
   * Automatically finds available port if requested port is in use
   */
  async start(
    config: BridgeConfig,
    autoFindPort: boolean = true
  ): Promise<{ success: boolean; error?: string; actualPort?: number }> {
    // If already running, stop first
    if (this.bridgeProcess) {
      await this.stop();
    }

    try {
      let actualConfig = { ...config };

      // Check if port is available, if not and autoFindPort is enabled, find next available
      const portAvailable = await isPortAvailable(config.port, config.host);

      if (!portAvailable && autoFindPort) {
        console.log(
          `[BridgeManager] Port ${config.port} is not available, searching for alternative...`
        );
        const availablePort = await findAvailablePort(
          config.port,
          config.port + 10, // Check next 10 ports
          config.host
        );

        if (availablePort) {
          console.log(
            `[BridgeManager] Found available port: ${availablePort} (requested: ${config.port})`
          );
          actualConfig = { ...config, port: availablePort };
        } else {
          return {
            success: false,
            error: `Port ${
              config.port
            } is not available and no alternative port found in range ${
              config.port
            }-${config.port + 10}`,
          };
        }
      } else if (!portAvailable) {
        return {
          success: false,
          error: `Port ${config.port} is already in use. Please choose a different port.`,
        };
      }

      this.config = actualConfig;

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

      let stderrBuffer = "";

      // Handle process events
      this.bridgeProcess.on("error", (error) => {
        console.error("Bridge process error:", error);
      });

      this.bridgeProcess.on("exit", (code, signal) => {
        console.log(
          `Bridge process exited with code ${code} and signal ${signal}`
        );
        this.bridgeProcess = null;
      });

      // Forward stdout/stderr for debugging
      if (this.bridgeProcess.stdout) {
        this.bridgeProcess.stdout.on("data", (data) => {
          //   console.log(`[Bridge] ${data.toString().trim()}`);
        });
      }

      if (this.bridgeProcess.stderr) {
        this.bridgeProcess.stderr.on("data", (data) => {
          const errorText = data.toString();
          stderrBuffer += errorText;
          console.error(`[Bridge Error] ${errorText.trim()}`);
        });
      }

      // Wait a bit to check if the process started successfully
      // If it exits quickly, it likely failed to bind
      console.log(
        "[BridgeManager] Waiting 2 seconds to verify process is running..."
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if process is still running
      const isStillRunning = this.bridgeProcess && !this.bridgeProcess.killed;
      console.log(
        `[BridgeManager] Process still running after 2s: ${isStillRunning}`
      );

      if (!isStillRunning) {
        // Extract error message from stderr
        let errorMessage = "Bridge process exited unexpectedly";

        // Try to extract meaningful error from stderr
        if (stderrBuffer) {
          const errorMatch = stderrBuffer.match(/EADDRNOTAVAIL[^\n]*/);
          if (errorMatch) {
            errorMessage = `Address not available: ${config.host}:${config.port}. This IP address is not available on your system.`;
          } else {
            const errorMatch2 = stderrBuffer.match(/ERROR[^\n]*/);
            if (errorMatch2) {
              errorMessage = errorMatch2[0].replace(/ERROR:\s*/, "");
            }
          }
        }

        this.bridgeProcess = null;
        console.log(`[BridgeManager] Process failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }

      console.log(
        `[BridgeManager] Process started successfully on port ${actualConfig.port}`
      );
      return {
        success: true,
        actualPort:
          actualConfig.port !== config.port ? actualConfig.port : undefined,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
      const errorMessage =
        error instanceof Error ? error.message : String(error);
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
