import { ChildProcess, spawn } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { isDev } from "../util.js";
import type { BridgeConfig } from "../types.js";
import { isPortAvailable, findAvailablePort } from "./port-checker.js";

/**
 * Bridge process manager
 * Handles starting, stopping, and monitoring the bridge process
 */
export class BridgeProcessManager {
  private bridgeProcess: ChildProcess | null = null;
  private config: BridgeConfig | null = null;
  private logStream: fs.WriteStream | null = null;

  private describeArtifact(relativePath: string): string {
    const absolutePath = path.join(process.resourcesPath, relativePath);
    if (!fs.existsSync(absolutePath)) {
      return `${relativePath}: missing`;
    }
    try {
      const stat = fs.statSync(absolutePath);
      const mode = `0${(stat.mode & 0o777).toString(8)}`;
      return `${relativePath}: ok size=${stat.size} mode=${mode}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${relativePath}: stat failed (${message})`;
    }
  }

  private logProductionArtifactStatus(): void {
    if (isDev()) {
      return;
    }

    const lines = [
      this.describeArtifact("bridge/dist/index.js"),
      this.describeArtifact(
        "bridge/dist/services/graphics/renderer/electron-renderer-entry.js"
      ),
      this.describeArtifact("bridge/native/framebus/build/Release/framebus.node"),
      this.describeArtifact("native/display-helper/display-helper"),
      this.describeArtifact("native/decklink-helper/decklink-helper"),
    ];

    lines.forEach((line) => {
      const message = `[BridgeManager] Release artifact check: ${line}\n`;
      if (this.logStream) {
        this.logStream.write(message);
      }
      console.log(message.trim());
    });
  }

  /**
   * Start the bridge process with given configuration
   * Automatically finds available port if requested port is in use
   */
  async start(
    config: BridgeConfig,
    autoFindPort: boolean = true,
    bridgeId?: string,
    relayUrl?: string,
    bridgeName?: string,
    pairingCode?: string,
    pairingExpiresAt?: number,
    relayEnabled: boolean = false
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
      const args = this.getBridgeArgs(
        actualConfig,
        bridgeId,
        relayUrl,
        bridgeName,
        relayEnabled
      );

      // Spawn bridge process
      // In production, set cwd to bridge resources directory so relative paths work correctly
      const cwd = isDev()
        ? path.join(app.getAppPath(), "apps/bridge")
        : path.join(process.resourcesPath, "bridge");

      // In production, use ELECTRON_RUN_AS_NODE=1 environment variable
      // This makes Electron run as Node.js without starting a new Electron instance
      const env: Record<string, string> = {
        ...process.env,
        NODE_ENV: isDev() ? "development" : "production",
      };

      if (relayEnabled) {
        env.BRIDGE_RELAY_ENABLED = "true";
      }

      // Avoid leaking pairing secrets via argv by passing them through env vars.
      if (pairingCode) {
        env.PAIRING_CODE = pairingCode;
      }
      if (typeof pairingExpiresAt === "number") {
        env.PAIRING_EXPIRES_AT = pairingExpiresAt.toString();
      }

      if (!isDev()) {
        env.ELECTRON_RUN_AS_NODE = "1";
      }

      // Setup logging for production
      if (!isDev()) {
        const logPath = path.join(
          app.getPath("userData"),
          "bridge-process.log"
        );
        try {
          this.logStream = fs.createWriteStream(logPath, { flags: "a" });
          this.logStream.write(
            `\n=== Bridge Process Started: ${new Date().toISOString()} ===\n`
          );
        } catch (error) {
          console.error("[BridgeManager] Failed to create log file:", error);
        }
      }

      this.bridgeProcess = spawn(bridgePath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        cwd,
        env,
      });
      this.logProductionArtifactStatus();

      let stderrBuffer = "";
      const shouldLogBridgeStdout =
        isDev() && process.env.BRIDGE_LOG_BRIDGE_STDOUT === "1";

      // Handle process events
      this.bridgeProcess.on("error", (error) => {
        const errorMsg = `Bridge process error: ${error.message}\n`;
        console.error(errorMsg);
        if (this.logStream) {
          this.logStream.write(`[ERROR] ${errorMsg}`);
        }
      });

      this.bridgeProcess.on("exit", (code, signal) => {
        const exitMsg = `Bridge process exited with code ${code} and signal ${signal}\n`;
        console.log(exitMsg);
        if (this.logStream) {
          this.logStream.write(`[EXIT] ${exitMsg}`);
          this.logStream.end();
          this.logStream = null;
        }
        this.bridgeProcess = null;
      });

      // Forward stdout/stderr for debugging
      if (this.bridgeProcess.stdout) {
        this.bridgeProcess.stdout.on("data", (data) => {
          const text = data.toString();
          if (shouldLogBridgeStdout) {
            // In development, log to console
            console.log(`[Bridge] ${text.trim()}`);
          }
          if (this.logStream) {
            this.logStream.write(`[STDOUT] ${text}`);
          }
        });
      }

      if (this.bridgeProcess.stderr) {
        this.bridgeProcess.stderr.on("data", (data) => {
          const errorText = data.toString();
          stderrBuffer += errorText;
          console.error(`[Bridge Error] ${errorText.trim()}`);
          if (this.logStream) {
            this.logStream.write(`[STDERR] ${errorText}`);
          }
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

      // Close log stream if open
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }

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
   * In production, uses Electron binary with ELECTRON_RUN_AS_NODE=1 env var to avoid requiring Node.js installation
   */
  private getBridgePath(): string {
    if (isDev()) {
      // Development: use npx to run tsx
      return "npx";
    } else {
      // Production: use Electron binary itself with ELECTRON_RUN_AS_NODE=1 environment variable
      // This avoids requiring users to have Node.js installed
      return process.execPath;
    }
  }

  /**
   * Get bridge arguments
   * In production, uses process.resourcesPath to access extraResources
   * ELECTRON_RUN_AS_NODE=1 is set as environment variable, not CLI flag
   */
  private getBridgeArgs(
    config: BridgeConfig,
    bridgeId?: string,
    relayUrl?: string,
    bridgeName?: string,
    relayEnabled: boolean = false
  ): string[] {
    const args: string[] = [];

    if (isDev()) {
      // Development: npx tsx src/index.ts --host ... --port ...
      args.push("tsx");
      args.push(path.join(app.getAppPath(), "apps/bridge/src/index.ts"));
    } else {
      // Production: Bridge is packaged in extraResources at resources/bridge/dist/index.js
      // ELECTRON_RUN_AS_NODE=1 is set as environment variable in spawn()
      const bridgeEntry = path.join(
        process.resourcesPath,
        "bridge",
        "dist",
        "index.js"
      );
      args.push(bridgeEntry);
    }

    // Add standard config args
    args.push("--host", config.host);
    args.push("--port", config.port.toString());

    if (config.userDataDir) {
      args.push("--user-data-dir", config.userDataDir);
    }

    // Add bridge ID if provided
    if (bridgeId) {
      args.push("--bridge-id", bridgeId);
    }

    if (bridgeName) {
      args.push("--bridge-name", bridgeName);
    }

    if (relayEnabled) {
      args.push("--relay-enabled");
    }

    // Add relay URL if provided
    if (relayUrl) {
      args.push("--relay-url", relayUrl);
    }

    return args;
  }
}

// Singleton instance
export const bridgeProcessManager = new BridgeProcessManager();
