import { app, BrowserWindow } from "electron";
import { ipcMainHandle, isDev, ipcWebContentsSend } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import { bridgeProcessManager } from "./services/bridge-process-manager.js";
import {
  startHealthCheckPolling,
  checkBridgeHealth,
} from "./services/bridge-health-check.js";
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
    const result = await bridgeProcessManager.start(config);

    // Start health check polling if bridge started successfully
    if (result.success) {
      // Stop existing health check if any
      if (healthCheckCleanup) {
        healthCheckCleanup();
      }

      // Start new health check
      healthCheckCleanup = startHealthCheckPolling(
        bridgeProcessManager.getConfig(),
        (status) => {
          ipcWebContentsSend("bridgeStatus", mainWindow.webContents, status);
        }
      );
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

    if (!isRunning || !config) {
      return {
        running: false,
        reachable: false,
      };
    }

    return await checkBridgeHealth(config);
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
