import { ChildProcess, spawn } from "child_process";
import { app } from "electron";
import path from "path";
import fs from "fs";
import { isDev } from "../util.js";

/**
 * Cloudflare Tunnel Manager
 * Handles starting, stopping, and monitoring the Cloudflare Tunnel process
 */
export class CloudflareTunnelManager {
  private tunnelProcess: ChildProcess | null = null;
  private tunnelUrl: string | null = null;
  private logStream: fs.WriteStream | null = null;

  /**
   * Check if cloudflared is available
   */
  async checkCloudflaredAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const checkProcess = spawn("cloudflared", ["--version"], {
        stdio: "ignore",
      });

      checkProcess.on("error", () => {
        resolve(false);
      });

      checkProcess.on("exit", (code) => {
        resolve(code === 0);
      });

      // Timeout after 3 seconds
      setTimeout(() => {
        checkProcess.kill();
        resolve(false);
      }, 3000);
    });
  }

  /**
   * Start Cloudflare Tunnel for local port
   */
  async start(
    localPort: number
  ): Promise<{ success: boolean; url?: string; error?: string }> {
    // If already running, stop first
    if (this.tunnelProcess) {
      await this.stop();
    }

    // Check if cloudflared is available
    const isAvailable = await this.checkCloudflaredAvailable();
    if (!isAvailable) {
      return {
        success: false,
        error:
          "cloudflared is not installed or not available in PATH. Please install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/",
      };
    }

    try {
      // Setup logging for production
      if (!isDev()) {
        const logPath = path.join(
          app.getPath("userData"),
          "cloudflare-tunnel.log"
        );
        try {
          this.logStream = fs.createWriteStream(logPath, { flags: "a" });
          this.logStream.write(
            `\n=== Cloudflare Tunnel Started: ${new Date().toISOString()} ===\n`
          );
        } catch (error) {
          console.error("[TunnelManager] Failed to create log file:", error);
        }
      }

      // Build cloudflared command for quick tunnel (no token needed)
      const localUrl = `http://localhost:${localPort}`;
      const args = ["tunnel", "--url", localUrl];

      console.log(
        `[TunnelManager] Starting cloudflared tunnel for port ${localPort}`
      );
      console.log(`[TunnelManager] Tunnel will connect to: ${localUrl}`);
      this.tunnelProcess = spawn("cloudflared", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdoutBuffer = "";
      let stderrBuffer = "";

      // Handle process events
      this.tunnelProcess.on("error", (error) => {
        const errorMsg = `Cloudflare tunnel error: ${error.message}\n`;
        console.error(errorMsg);
        if (this.logStream) {
          this.logStream.write(`[ERROR] ${errorMsg}`);
        }
      });

      this.tunnelProcess.on("exit", (code, signal) => {
        const exitMsg = `Cloudflare tunnel exited with code ${code} and signal ${signal}\n`;
        console.log(exitMsg);
        if (this.logStream) {
          this.logStream.write(`[EXIT] ${exitMsg}`);
          this.logStream.end();
          this.logStream = null;
        }
        this.tunnelProcess = null;
        this.tunnelUrl = null;
      });

      // Helper function to extract URL from text
      const extractUrl = (text: string): string | null => {
        // Cloudflare outputs the URL in a box format like:
        // |  https://xxxxx.trycloudflare.com                                |
        // We need to extract only the base URL without paths

        // First, try to find URLs in the box format (most reliable)
        const boxPattern =
          /\|\s*(https:\/\/[a-z0-9-]+\.trycloudflare\.com)\s*\|/gi;
        const boxMatch = text.match(boxPattern);
        if (boxMatch && boxMatch[0]) {
          const url = boxMatch[0].replace(/\|\s*|\s*\|/g, "").trim();
          if (
            url.startsWith("https://") &&
            url.includes(".trycloudflare.com")
          ) {
            return url;
          }
        }

        // Fallback: Standard patterns (but exclude URLs with paths)
        const patterns = [
          // Standard trycloudflare.com format - must be base URL only (no path)
          /https:\/\/[a-z0-9-]+\.trycloudflare\.com(?:\s|$|[^\w\/-])/gi,
          // Alternative cloudflare tunnel domain
          /https:\/\/[a-z0-9-]+\.cloudflaretunnel\.com(?:\s|$|[^\w\/-])/gi,
        ];

        for (const pattern of patterns) {
          const matches = text.matchAll(pattern);
          for (const match of matches) {
            if (match[0]) {
              // Clean up the URL (remove quotes, trailing characters)
              let url = match[0].trim();
              // Remove quotes if present
              url = url.replace(/^["']|["']$/g, "");
              // Remove trailing punctuation that might have been captured
              url = url.replace(/[.,;:!?)+)\s]+$/, "");

              // CRITICAL: Reject URLs with paths (like /website-terms/)
              if (url.includes("/") && !url.match(/^https?:\/\/[^\/]+$/)) {
                continue; // Skip URLs with paths
              }

              // Validate: must be a tunnel URL (trycloudflare.com or cloudflaretunnel.com)
              if (
                (url.startsWith("http://") || url.startsWith("https://")) &&
                (url.includes(".trycloudflare.com") ||
                  url.includes(".cloudflaretunnel.com"))
              ) {
                // Ensure it's just the base URL, not a path
                try {
                  const urlObj = new URL(url);
                  // Return only the origin (protocol + host) - no path allowed
                  if (urlObj.pathname === "/" || urlObj.pathname === "") {
                    return `${urlObj.protocol}//${urlObj.host}`;
                  }
                } catch {
                  // If URL parsing fails, skip it
                  continue;
                }
              }
            }
          }
        }

        return null;
      };

      // Helper to check and extract URL from buffers
      const checkForUrl = () => {
        if (this.tunnelUrl) return; // Already found

        const allText = stdoutBuffer + stderrBuffer;
        const extractedUrl = extractUrl(allText);
        if (extractedUrl) {
          this.tunnelUrl = extractedUrl;
          console.log(`[TunnelManager] Tunnel URL detected: ${this.tunnelUrl}`);
        }
      };

      // Collect stdout for URL extraction
      if (this.tunnelProcess.stdout) {
        this.tunnelProcess.stdout.on("data", (data) => {
          const text = data.toString();
          stdoutBuffer += text;

          if (isDev()) {
            console.log(`[Tunnel STDOUT] ${text.trim()}`);
          }
          if (this.logStream) {
            this.logStream.write(`[STDOUT] ${text}`);
          }

          // Check for URL after each chunk
          checkForUrl();
        });
      }

      // Collect stderr (URL might also be in stderr)
      if (this.tunnelProcess.stderr) {
        this.tunnelProcess.stderr.on("data", (data) => {
          const errorText = data.toString();
          stderrBuffer += errorText;

          if (isDev()) {
            console.log(`[Tunnel STDERR] ${errorText.trim()}`);
          }
          // Only log as error if it's actually an error (not just info messages)
          if (errorText.includes("ERR")) {
            console.error(`[Tunnel Error] ${errorText.trim()}`);
          }
          if (this.logStream) {
            this.logStream.write(`[STDERR] ${errorText}`);
          }

          // Check for URL after each chunk
          checkForUrl();
        });
      }

      // Wait for URL extraction (max 30 seconds - cloudflared can take time)
      const maxWaitTime = 30000; // 30 seconds
      const startTime = Date.now();

      while (!this.tunnelUrl && Date.now() - startTime < maxWaitTime) {
        await new Promise((resolve) => setTimeout(resolve, 200));

        // Check if process is still running
        if (!this.tunnelProcess || this.tunnelProcess.killed) {
          break;
        }
      }

      // Check if process is still running
      const isStillRunning = this.tunnelProcess && !this.tunnelProcess.killed;

      if (!isStillRunning) {
        // Extract error message from stderr
        let errorMessage = "Cloudflare tunnel exited unexpectedly";

        if (stderrBuffer) {
          const errorMatch = stderrBuffer.match(/error[^\n]*/i);
          if (errorMatch) {
            errorMessage = errorMatch[0];
          }
        }

        this.tunnelProcess = null;
        console.log(`[TunnelManager] Tunnel failed: ${errorMessage}`);
        return { success: false, error: errorMessage };
      }

      if (!this.tunnelUrl) {
        // Try to extract URL from accumulated buffers as fallback
        const allOutput = stdoutBuffer + stderrBuffer;
        const extractedUrl = extractUrl(allOutput);
        if (extractedUrl) {
          this.tunnelUrl = extractedUrl;
          console.log(
            `[TunnelManager] Tunnel URL detected from buffer: ${this.tunnelUrl}`
          );
        } else {
          // Process is running but no URL found
          // Log full output for debugging (truncated to 2000 chars each)
          console.error(
            `[TunnelManager] Could not extract URL after ${Math.round(
              (Date.now() - startTime) / 1000
            )}s.`
          );
          console.error(
            `[TunnelManager] stdout (first 1000 chars):\n${stdoutBuffer.substring(
              0,
              1000
            )}`
          );
          console.error(
            `[TunnelManager] stderr (first 1000 chars):\n${stderrBuffer.substring(
              0,
              1000
            )}`
          );

          // If process is still running, we can continue and try to get URL later
          // The tunnel might still work, we just don't have the URL yet
          if (isStillRunning) {
            console.warn(
              "[TunnelManager] Tunnel is running but URL not found. It may appear later. Continuing..."
            );
            // Return success but without URL - we'll try to get it later via getUrl()
            return {
              success: true,
              // url is undefined - we'll try to get it later via getUrl()
            };
          }

          return {
            success: false,
            error:
              "Tunnel started but URL could not be extracted. Check logs for details.",
          };
        }
      }

      console.log(`[TunnelManager] Tunnel started successfully!`);
      console.log(`[TunnelManager] Public Tunnel URL: ${this.tunnelUrl}`);
      console.log(`[TunnelManager] Tunnel connects to: ${localUrl}`);
      return {
        success: true,
        url: this.tunnelUrl,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Stop the Cloudflare Tunnel process
   */
  async stop(): Promise<void> {
    if (!this.tunnelProcess) {
      return;
    }

    try {
      // Send SIGTERM for graceful shutdown
      this.tunnelProcess.kill("SIGTERM");

      // Wait for process to exit (max 5 seconds)
      await new Promise<void>((resolve, reject) => {
        if (!this.tunnelProcess) {
          resolve();
          return;
        }

        const timeout = setTimeout(() => {
          // Force kill if still running
          if (this.tunnelProcess) {
            this.tunnelProcess.kill("SIGKILL");
          }
          reject(new Error("Tunnel process did not exit in time"));
        }, 5000);

        this.tunnelProcess.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      // Close log stream if open
      if (this.logStream) {
        this.logStream.end();
        this.logStream = null;
      }

      this.tunnelProcess = null;
      this.tunnelUrl = null;
      console.log("[TunnelManager] Tunnel stopped");
    } catch (error) {
      console.error("[TunnelManager] Error stopping tunnel:", error);
      // Force kill if graceful shutdown failed
      if (this.tunnelProcess) {
        this.tunnelProcess.kill("SIGKILL");
        this.tunnelProcess = null;
      }
      this.tunnelUrl = null;
    }
  }

  /**
   * Check if tunnel process is running
   */
  isRunning(): boolean {
    return this.tunnelProcess !== null && !this.tunnelProcess.killed;
  }

  /**
   * Get current tunnel URL
   */
  getUrl(): string | null {
    return this.tunnelUrl;
  }
}

// Singleton instance
export const cloudflareTunnelManager = new CloudflareTunnelManager();
