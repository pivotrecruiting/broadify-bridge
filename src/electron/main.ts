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
import { discoverOutputs } from "./services/device-detector.js";
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
} from "../../types.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

const PORT = process.env.PORT || "5173"; // Default to Vite's default port

let healthCheckCleanup: (() => void) | null = null;
let bridgeOutputs: { output1: string; output2: string } | null = null;
let currentNetworkBindingId: string | null = null;
let hasOpenedWebApp = false;

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
  port: number,
  outputs: { output1: string; output2: string }
): string | null {
  const baseUrl = process.env.STUDIO_CONTROL_WEBAPP_URL;
  if (!baseUrl) {
    console.warn(
      "[WebApp] STUDIO_CONTROL_WEBAPP_URL not set, skipping web app open"
    );
    return null;
  }

  try {
    const url = new URL(baseUrl);
    url.searchParams.set("ip", ip);
    url.searchParams.set("iptype", iptype);
    url.searchParams.set("port", port.toString());
    url.searchParams.set("output1", outputs.output1);
    url.searchParams.set("output2", outputs.output2);

    return url.toString();
  } catch (error) {
    console.error("[WebApp] Error building web app URL:", error);
    return null;
  }
}

app.on("ready", () => {
  const mainWindow = new BrowserWindow({
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
    console.log("[Bridge] Starting bridge with config:", config);

    // Store outputs and reset web app flag
    if (config.outputs) {
      bridgeOutputs = config.outputs;
    }
    hasOpenedWebApp = false;

    // Store network binding ID
    currentNetworkBindingId = config.networkBindingId || "localhost";

    const result = await bridgeProcessManager.start(config, true); // autoFindPort = true
    console.log("[Bridge] Start result:", result);

    // Start health check polling if bridge started successfully
    if (result.success) {
      console.log(
        "[Bridge] Bridge started successfully, sending initial status update"
      );
      // Immediately send status update that bridge is starting
      const initialStatus = {
        running: true,
        reachable: false,
      };
      console.log("[Bridge] Sending initial status:", initialStatus);
      ipcWebContentsSend("bridgeStatus", mainWindow.webContents, initialStatus);

      // Stop existing health check if any
      if (healthCheckCleanup) {
        console.log("[Bridge] Stopping existing health check");
        healthCheckCleanup();
      }

      const bridgeConfig = bridgeProcessManager.getConfig();
      console.log(
        "[Bridge] Starting health check polling with config:",
        bridgeConfig
      );

      // Start new health check
      healthCheckCleanup = startHealthCheckPolling(
        bridgeConfig,
        (status) => {
          console.log("[Bridge] Health check status update:", status);
          ipcWebContentsSend("bridgeStatus", mainWindow.webContents, status);

          // Auto-open web app when bridge becomes reachable
          // Get fresh bridge config in case it changed
          const currentBridgeConfig = bridgeProcessManager.getConfig();

          if (
            status.reachable &&
            !hasOpenedWebApp &&
            bridgeOutputs &&
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
              const webAppUrl = buildWebAppUrl(
                resolvedIp,
                interfaceType,
                currentBridgeConfig.port,
                bridgeOutputs
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
      console.log("[Bridge] Bridge start failed:", result.error);
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
    bridgeOutputs = null;
    currentNetworkBindingId = null;

    // Send final status update
    ipcWebContentsSend("bridgeStatus", mainWindow.webContents, {
      running: false,
      reachable: false,
    });

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
      console.log(`[Bridge] GetStatus - Process not running or no config`);
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
    console.log(`[Bridge] GetStatus result:`, status);
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

    // If bridge is not running or outputs not available, detect devices directly in Main Process
    console.log("[OutputChecker] Detecting devices in Main Process");
    const outputs = await discoverOutputs();

    const output1Count = outputs.output1?.length || 0;
    const output2Count = outputs.output2?.length || 0;
    const availableOutput1Count =
      outputs.output1?.filter((opt) => opt.available).length || 0;
    const availableOutput2Count =
      outputs.output2?.filter((opt) => opt.available).length || 0;

    console.log(
      `[OutputChecker] Detected devices - Output1: ${availableOutput1Count}/${output1Count} available, Output2: ${availableOutput2Count}/${output2Count} available`
    );

    return outputs;
  });

  // Cleanup on window close
  mainWindow.on("close", async (event) => {
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
