import { app, BrowserWindow, shell } from "electron";
import { ipcMainHandle, isDev, ipcWebContentsSend } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { bridgeProcessManager } from "./services/bridge-process-manager.js";
import {
  startHealthCheckPolling,
  checkBridgeHealth,
} from "./services/bridge-health-check.js";
import { fetchBridgeOutputs } from "./services/bridge-outputs.js";
import { bridgeIdentity } from "./services/bridge-identity.js";
import {
  isPortAvailable,
  checkPortsAvailability,
} from "./services/port-checker.js";
import {
  detectNetworkInterfaces,
  resolveBindAddress,
} from "./services/network-interface-detector.js";
import type {
  BridgeConfig,
  NetworkConfigT,
  NetworkBindingOptionT,
} from "./types.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import * as Sentry from "@sentry/electron";

dotenv.config();

// Initialize Sentry in Main Process (before app.on('ready'))
// This enables both Main and Renderer process error tracking
Sentry.init({
  dsn: "https://a534ee90c276b99d94aec4c22e6fc8c3@o4510578425135104.ingest.de.sentry.io/4510578677645392",
  // Electron SDK automatically handles Main + Renderer integration
  // Renderer integration will be initialized automatically
});

const PORT = process.env.PORT || "5173"; // Default to Vite's default port

let healthCheckCleanup: (() => void) | null = null;
// Outputs are now configured in the web app, not stored here
let currentNetworkBindingId: string | null = null;
let hasOpenedWebApp = false;
let mainWindow: BrowserWindow | null = null;

/**
 * Default network configuration
 */
const DEFAULT_NETWORK_CONFIG: NetworkConfigT = {
  networkBinding: {
    default: {
      id: "localhost",
      label: "Localhost (127.0.0.1)",
      bindAddress: "127.0.0.1",
      recommended: false,
      advanced: false,
      description: "Only accessible from this computer. Recommended default.",
    },
    options: [
      {
        id: "localhost",
        label: "Localhost (127.0.0.1)",
        bindAddress: "127.0.0.1",
        interface: "loopback",
        recommended: false,
        advanced: false,
      },
      {
        id: "ethernet",
        label: "Ethernet",
        bindAddress: "AUTO_IPV4",
        interface: "ethernet",
        recommended: false,
        advanced: false,
      },
      {
        id: "wifi",
        label: "Wi-Fi",
        bindAddress: "AUTO_IPV4",
        interface: "wifi",
        recommended: false,
        advanced: false,
        warning: "Wired Ethernet recommended for live production.",
      },
      {
        id: "all",
        label: "All Interfaces (Advanced)",
        bindAddress: "0.0.0.0",
        interface: "all",
        recommended: false,
        advanced: true,
        warning: "Exposes the bridge to the entire network.",
      },
    ],
    filters: {
      excludeInterfaces: ["docker", "vbox", "vmnet", "utun", "wg", "tailscale"],
      excludeIpRanges: ["169.254.0.0/16"],
      ipv6: false,
    },
  },
  port: {
    default: 8787,
    autoFallback: [8788, 8789, 8790],
    allowCustom: true,
    customAdvancedOnly: true,
  },
  security: {
    lanMode: {
      enabled: false,
      requireAuth: false,
      readOnlyWithoutAuth: true,
    },
  },
};

/**
 * Load network configuration for the Desktop App (not the Bridge)
 *
 * This config is used by the Desktop App UI to show network interface options
 * and port settings. The Bridge itself receives these values as CLI arguments.
 *
 * Priority:
 * 1. User's saved config in Electron's userData directory
 * 2. Template config from config/network-config.json (copied to userData on first run)
 * 3. Hardcoded DEFAULT_NETWORK_CONFIG as final fallback
 */
function loadNetworkConfig(): NetworkConfigT {
  // Electron's userData directory (e.g. ~/Library/Application Support/electron-vite-template on macOS)
  const userDataConfigPath = path.join(
    app.getPath("userData"),
    "network-config.json"
  );

  // Try to load from user data directory (user's saved config)
  try {
    if (fs.existsSync(userDataConfigPath)) {
      const configData = fs.readFileSync(userDataConfigPath, "utf-8");
      const config = JSON.parse(configData) as NetworkConfigT;
      return config;
    }
  } catch (error) {
    console.error("[NetworkConfig] Error loading user config:", error);
  }

  // On first run, try to use config/network-config.json as template
  // This is the project's default config file
  try {
    const templateConfigPath = path.join(
      process.cwd(),
      "config",
      "network-config.json"
    );

    if (fs.existsSync(templateConfigPath)) {
      const templateData = fs.readFileSync(templateConfigPath, "utf-8");
      const templateConfig = JSON.parse(templateData) as NetworkConfigT;

      // Copy template to Electron's userData directory for future use
      // This allows users to customize their config without modifying the project file
      try {
        fs.writeFileSync(
          userDataConfigPath,
          JSON.stringify(templateConfig, null, 2),
          "utf-8"
        );
      } catch (writeError) {
        console.warn(
          "[NetworkConfig] Could not write user config, using template in memory:",
          writeError
        );
      }

      return templateConfig;
    }
  } catch (error) {
    console.error("[NetworkConfig] Error loading template config:", error);
  }

  // Final fallback to hardcoded default config
  return DEFAULT_NETWORK_CONFIG;
}

/**
 * Get interface type from binding ID
 */
function getInterfaceType(
  bindingId: string,
  options: NetworkBindingOptionT[]
): string {
  const option = options.find((opt) => opt.id === bindingId);
  return option?.interface || "localhost";
}

/**
 * Build Web-App URL with query parameters
 */
function buildWebAppUrl(
  ip: string,
  iptype: string,
  port: number
): string | null {
  // Select URL based on environment
  const envVarName = isDev()
    ? "DEVELOPMENT_STUDIO_CONTROL_WEBAPP_URL"
    : "PRODUCTION_STUDIO_CONTROL_WEBAPP_URL";
  const baseUrl = process.env[envVarName];

  if (!baseUrl) {
    console.warn(`[WebApp] ${envVarName} not set, skipping web app open`);
    return null;
  }

  try {
    const url = new URL(baseUrl);

    url.searchParams.set("ip", ip);
    url.searchParams.set("iptype", iptype);
    url.searchParams.set("port", port.toString());
    // Outputs are now configured in the web app, not via URL params

    return url.toString();
  } catch (error) {
    console.error("[WebApp] Error building web app URL:", error);
    return null;
  }
}

// Single Instance Lock: Prevent multiple instances of the app
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running, quit this one
  app.quit();
} else {
  // Handle second instance: focus existing window
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // macOS: Handle open-url event (for protocol handlers)
  app.on("open-url", (event, url) => {
    event.preventDefault();
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      // Handle URL if needed (e.g., pass to renderer via IPC)
    }
  });

  app.on("ready", () => {
    mainWindow = new BrowserWindow({
      // Shouldn't add contextIsolate or nodeIntegration because of security vulnerabilities
      webPreferences: {
        preload: getPreloadPath(),
      },
      icon: getIconPath(),
      width: 800, // sm breakpoint width (640px) + padding
      height: 700, // Fixed height to prevent scrolling
      minWidth: 640, // Minimum width (sm breakpoint)
      minHeight: 600,
      resizable: true,
    });

    if (isDev()) mainWindow.loadURL(`http://localhost:${PORT}`);
    else mainWindow.loadFile(getUIPath());

    pollResources(mainWindow);

    // Existing IPC handlers
    ipcMainHandle("getStaticData", () => {
      return getStaticData();
    });

    // Bridge IPC handlers
    ipcMainHandle("bridgeStart", async (event, config: BridgeConfig) => {
      // console.log("[Bridge] Starting bridge with config:", config);

      // Outputs are now configured in the web app via POST /config endpoint
      hasOpenedWebApp = false;

      // Get bridge ID
      const bridgeId = bridgeIdentity.getBridgeId();

      // Store network binding ID
      currentNetworkBindingId = config.networkBindingId || "localhost";

      // Resolve bind address to actual IP address
      const networkConfig = loadNetworkConfig();
      const networkBindingOptions = detectNetworkInterfaces(
        networkConfig.networkBinding.options,
        networkConfig.networkBinding.filters
      );

      const interfaceType = getInterfaceType(
        currentNetworkBindingId,
        networkBindingOptions
      );
      const matchingOption = networkBindingOptions.find(
        (opt) => opt.id === currentNetworkBindingId
      );

      let resolvedHost = config.host;
      if (matchingOption) {
        // Resolve IP address (handles AUTO_IPV4, 0.0.0.0, etc.)
        resolvedHost = resolveBindAddress(
          matchingOption.bindAddress,
          interfaceType,
          networkConfig.networkBinding.filters
        );
      }

      // Create resolved config for bridge
      const resolvedConfig: BridgeConfig = {
        ...config,
        host: resolvedHost,
      };

      // Get relay URL from environment or use default
      const relayUrl = process.env.RELAY_URL || "wss://relay.broadify.de";

      // Start bridge without requiring outputs
      // Pass bridgeId and relayUrl as CLI args
      const result = await bridgeProcessManager.start(
        resolvedConfig,
        true, // autoFindPort = true
        bridgeId,
        relayUrl
      );
      console.log("[Bridge] Start result:", result);

      // Start health check polling if bridge started successfully
      if (result.success) {
        // console.log(
        //   "[Bridge] Bridge started successfully, sending initial status update"
        // );
        // Immediately send status update that bridge is starting
        const initialStatus = {
          running: true,
          reachable: false,
          bridgeId,
        };

        // console.log("[Bridge] Sending initial status:", initialStatus);
        if (mainWindow) {
          ipcWebContentsSend(
            "bridgeStatus",
            mainWindow.webContents,
            initialStatus
          );
        }

        // Stop existing health check if any
        if (healthCheckCleanup) {
          // console.log("[Bridge] Stopping existing health check");
          healthCheckCleanup();
        }

        const bridgeConfig = bridgeProcessManager.getConfig();
        // console.log(
        //   "[Bridge] Starting health check polling with config:",
        //   bridgeConfig
        // );

        // Start new health check
        healthCheckCleanup = startHealthCheckPolling(
          bridgeConfig,
          (status) => {
            // console.log("[Bridge] Health check status update:", status);

            if (mainWindow) {
              ipcWebContentsSend(
                "bridgeStatus",
                mainWindow.webContents,
                status
              );
            }

            // Auto-open web app when bridge becomes reachable
            // Get fresh bridge config in case it changed
            const currentBridgeConfig = bridgeProcessManager.getConfig();

            // Auto-open web app when bridge becomes reachable
            // Outputs are no longer required - web app can handle output configuration
            if (
              status.reachable &&
              !hasOpenedWebApp &&
              currentBridgeConfig &&
              currentNetworkBindingId
            ) {
              const networkConfig = loadNetworkConfig();
              const networkBindingOptions = detectNetworkInterfaces(
                networkConfig.networkBinding.options,
                networkConfig.networkBinding.filters
              );

              const interfaceType = getInterfaceType(
                currentNetworkBindingId,
                networkBindingOptions
              );
              const matchingOption = networkBindingOptions.find(
                (opt) => opt.id === currentNetworkBindingId
              );

              if (matchingOption) {
                // Resolve IP address
                const resolvedIp = resolveBindAddress(
                  matchingOption.bindAddress,
                  interfaceType,
                  networkConfig.networkBinding.filters
                );

                // Build and open web app URL
                // Outputs are now configured in the web app, not via URL params
                const webAppUrl = buildWebAppUrl(
                  resolvedIp,
                  interfaceType,
                  currentBridgeConfig.port
                );

                if (webAppUrl) {
                  shell.openExternal(webAppUrl);
                  hasOpenedWebApp = true;
                }
              }
            }
          },
          () => bridgeProcessManager.isRunning() // Pass function to check if process is running
        );
      } else {
        // console.log("[Bridge] Bridge start failed:", result.error);
      }

      return result;
    });

    ipcMainHandle("bridgeStop", async () => {
      // Stop health check
      if (healthCheckCleanup) {
        healthCheckCleanup();
        healthCheckCleanup = null;
      }

      const result = await bridgeProcessManager.stop();

      // Reset web app flag and outputs
      hasOpenedWebApp = false;
      // Outputs are managed in the web app
      currentNetworkBindingId = null;

      // Send final status update
      if (mainWindow) {
        ipcWebContentsSend("bridgeStatus", mainWindow.webContents, {
          running: false,
          reachable: false,
        });
      }

      return result;
    });

    ipcMainHandle("bridgeGetStatus", async () => {
      const config = bridgeProcessManager.getConfig();
      const isRunning = bridgeProcessManager.isRunning();

      console.log(
        `[Bridge] GetStatus - isRunning: ${isRunning}, config:`,
        config
      );

      if (!isRunning || !config) {
        // console.log(`[Bridge] GetStatus - Process not running or no config`);
        return {
          running: false,
          reachable: false,
        };
      }

      const healthStatus = await checkBridgeHealth(config);
      // Ensure running is true if process is running, even if not reachable yet
      const status = {
        ...healthStatus,
        running: isRunning, // Always use actual process state
      };

      // console.log(`[Bridge] GetStatus result:`, status);
      return status;
    });

    // Port checking IPC handlers
    ipcMainHandle(
      "checkPortAvailability",
      async (event, port: number, host?: string) => {
        const available = await isPortAvailable(port, host || "0.0.0.0");
        return { port, available };
      }
    );

    ipcMainHandle(
      "checkPortsAvailability",
      async (event, ports: number[], host?: string) => {
        const checkHost = host || "0.0.0.0";
        const results = await checkPortsAvailability(ports, checkHost);
        const resultArray = Array.from(results.entries()).map(
          ([port, available]) => ({
            port,
            available,
          })
        );
        return resultArray;
      }
    );

    // Network configuration IPC handlers
    ipcMainHandle("getNetworkConfig", async () => {
      const config = loadNetworkConfig();
      return config;
    });

    ipcMainHandle("detectNetworkInterfaces", async () => {
      const config = loadNetworkConfig();
      const options = detectNetworkInterfaces(
        config.networkBinding.options,
        config.networkBinding.filters
      );

      return options;
    });

    ipcMainHandle("getNetworkBindingOptions", async () => {
      const config = loadNetworkConfig();
      const options = detectNetworkInterfaces(
        config.networkBinding.options,
        config.networkBinding.filters
      );

      return options;
    });

    /**
     * Helper function to make requests to Bridge API
     */
    async function bridgeApiRequest(
      endpoint: string,
      options: RequestInit = {}
    ): Promise<unknown> {
      const config = bridgeProcessManager.getConfig();
      if (!config) {
        throw new Error("Bridge is not running");
      }

      const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
      const url = `http://${host}:${config.port}${endpoint}`;

      const controller = new AbortController();
      // Use longer timeout for engine/connect (15s) to allow for device connection timeout (10s)
      const timeoutMs = endpoint === "/engine/connect" ? 15000 : 10000; // 15s for connect, 10s for others
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        // Build headers: only set Content-Type if body exists
        const headers: Record<string, string> = {};
        if (options.headers) {
          Object.entries(options.headers).forEach(([key, value]) => {
            if (typeof value === "string") {
              headers[key] = value;
            }
          });
        }
        if (options.body && !headers["Content-Type"]) {
          headers["Content-Type"] = "application/json";
        }

        const response = await fetch(url, {
          ...options,
          signal: controller.signal,
          headers,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.message || errorData.error || `HTTP ${response.status}`
          );
        }

        return await response.json();
      } catch (error) {
        clearTimeout(timeoutId);
        if (error instanceof Error) {
          throw error;
        }
        throw new Error("Unknown error");
      }
    }

    // Engine IPC handlers
    ipcMainHandle(
      "engineConnect",
      async (event, type: string, ip?: string, port?: number) => {
        try {
          // Validate type
          if (!type || !["atem", "tricaster", "vmix"].includes(type)) {
            return {
              success: false,
              error:
                "Invalid engine type. Must be 'atem', 'tricaster', or 'vmix'",
            };
          }

          // Validate required fields
          if (!ip) {
            return {
              success: false,
              error: "IP address is required",
            };
          }

          if (!port) {
            return {
              success: false,
              error: "Port is required",
            };
          }

          const body = {
            type: type as "atem" | "tricaster" | "vmix",
            ip,
            port,
          };

          const result = (await bridgeApiRequest("/engine/connect", {
            method: "POST",
            body: JSON.stringify(body),
          })) as { state?: unknown };

          return {
            success: true,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            state: result.state as any,
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "Unknown error",
          };
        }
      }
    );

    ipcMainHandle("engineDisconnect", async () => {
      try {
        const result = (await bridgeApiRequest("/engine/disconnect", {
          method: "POST",
        })) as { state?: unknown };

        return {
          success: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state: result.state as any,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    ipcMainHandle("engineGetStatus", async () => {
      try {
        const result = (await bridgeApiRequest("/engine/status")) as {
          state?: unknown;
        };
        return {
          success: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state: result.state as any,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          state: {
            status: "error",
            macros: [],
            error: error instanceof Error ? error.message : "Unknown error",
          },
        };
      }
    });

    ipcMainHandle("engineGetMacros", async () => {
      try {
        const result = (await bridgeApiRequest("/engine/macros")) as {
          success?: boolean;
          macros?: unknown[];
          error?: string;
          message?: string;
        };

        // Check if response indicates failure
        if (result.success === false) {
          return {
            success: false,
            error: result.error || result.message || "Failed to get macros",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            macros: (result.macros || []) as any,
          };
        }

        return {
          success: true,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          macros: (result.macros || []) as any,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          macros: [],
        };
      }
    });

    ipcMainHandle("engineRunMacro", async (event, macroId: number) => {
      try {
        const result = (await bridgeApiRequest(
          `/engine/macros/${macroId}/run`,
          {
            method: "POST",
          }
        )) as {
          success?: boolean;
          state?: unknown;
          error?: string;
          message?: string;
        };

        // Check if response indicates failure
        if (result.success === false) {
          return {
            success: false,
            error: result.error || result.message || "Failed to run macro",
          };
        }

        return {
          success: true,
          macroId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state: result.state as any,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    ipcMainHandle("engineStopMacro", async (event, macroId: number) => {
      try {
        const result = (await bridgeApiRequest(
          `/engine/macros/${macroId}/stop`,
          {
            method: "POST",
          }
        )) as {
          success?: boolean;
          state?: unknown;
          error?: string;
          message?: string;
        };

        // Check if response indicates failure
        if (result.success === false) {
          return {
            success: false,
            error: result.error || result.message || "Failed to stop macro",
          };
        }

        return {
          success: true,
          macroId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          state: result.state as any,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    // Bridge outputs IPC handler
    ipcMainHandle("bridgeGetOutputs", async () => {
      console.log("[OutputChecker] Getting outputs");
      const config = bridgeProcessManager.getConfig();

      // If bridge is running, try to get outputs from bridge (for updates)
      if (config) {
        const bridgeOutputs = await fetchBridgeOutputs(config);
        if (bridgeOutputs) {
          const output1Count = bridgeOutputs.output1?.length || 0;
          const output2Count = bridgeOutputs.output2?.length || 0;
          const availableOutput1Count =
            bridgeOutputs.output1?.filter((opt) => opt.available).length || 0;
          const availableOutput2Count =
            bridgeOutputs.output2?.filter((opt) => opt.available).length || 0;

          console.log(
            `[OutputChecker] Fetched outputs from bridge - Output1: ${availableOutput1Count}/${output1Count} available, Output2: ${availableOutput2Count}/${output2Count} available`
          );

          return bridgeOutputs;
        }
        console.log(
          "[OutputChecker] Bridge running but outputs not available, falling back to device detection"
        );
      }

      // Bridge is Single Source of Truth - no fallback detection in Main Process
      console.log(
        "[OutputChecker] Bridge not running, returning empty outputs (Bridge is Single Source of Truth)"
      );
      return {
        output1: [],
        output2: [],
      };
    });

    // Open external URL handler
    ipcMainHandle("openExternal", async (event, url: string) => {
      if (typeof url === "string" && url.startsWith("http")) {
        shell.openExternal(url);
      }
    });

    // Cleanup on window close
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    mainWindow.on("close", async (_event) => {
      if (healthCheckCleanup) {
        healthCheckCleanup();
        healthCheckCleanup = null;
      }
      await bridgeProcessManager.stop();
    });

    // Cleanup on app quit
    app.on("before-quit", async () => {
      if (healthCheckCleanup) {
        healthCheckCleanup();
        healthCheckCleanup = null;
      }
      await bridgeProcessManager.stop();
    });
  });
}
