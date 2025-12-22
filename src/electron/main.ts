import { app, BrowserWindow, shell } from "electron";
import { ipcMainHandle, isDev, ipcWebContentsSend } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { bridgeProcessManager } from "./services/bridge-process-manager.js";
import {
  startHealthCheckPolling,
  checkBridgeHealth,
} from "./services/bridge-health-check.js";
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
      label: "Localhost (Secure)",
      bindAddress: "127.0.0.1",
      recommended: true,
      advanced: false,
      description: "Only accessible from this computer. Recommended default.",
    },
    options: [
      {
        id: "localhost",
        label: "Localhost (Secure)",
        bindAddress: "127.0.0.1",
        interface: "loopback",
        recommended: true,
        advanced: false,
      },
      {
        id: "ethernet",
        label: "Ethernet",
        bindAddress: "AUTO_IPV4",
        interface: "ethernet",
        recommended: true,
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
 * Load network configuration from file or return default
 */
function loadNetworkConfig(): NetworkConfigT {
  try {
    const configPath = path.join(
      app.getPath("userData"),
      "network-config.json"
    );

    if (fs.existsSync(configPath)) {
      const configData = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(configData) as NetworkConfigT;
      return config;
    }
  } catch (error) {
    console.error("[NetworkConfig] Error loading config:", error);
  }

  // Fallback to default config
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
      console.log(`[PortChecker] Checking ports:`, ports, `on ${checkHost}`);
      const results = await checkPortsAvailability(ports, checkHost);
      const resultArray = Array.from(results.entries()).map(
        ([port, available]) => ({
          port,
          available,
        })
      );
      console.log(`[PortChecker] Port availability results:`, resultArray);
      return resultArray;
    }
  );

  // Network configuration IPC handlers
  ipcMainHandle("getNetworkConfig", async () => {
    console.log("[NetworkConfig] Loading network configuration");
    const config = loadNetworkConfig();
    return config;
  });

  ipcMainHandle("detectNetworkInterfaces", async () => {
    console.log("[NetworkConfig] Detecting network interfaces");
    const config = loadNetworkConfig();
    const options = detectNetworkInterfaces(
      config.networkBinding.options,
      config.networkBinding.filters
    );
    console.log("[NetworkConfig] Detected interfaces:", options);
    return options;
  });

  ipcMainHandle("getNetworkBindingOptions", async () => {
    console.log("[NetworkConfig] Getting network binding options");
    const config = loadNetworkConfig();
    const options = detectNetworkInterfaces(
      config.networkBinding.options,
      config.networkBinding.filters
    );
    console.log("[NetworkConfig] Network binding options:", options);
    return options;
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
