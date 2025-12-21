import { app, BrowserWindow } from "electron";
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
import type { BridgeConfig } from "../../types.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || "5173"; // Default to Vite's default port

let healthCheckCleanup: (() => void) | null = null;

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
