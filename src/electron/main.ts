import { app, BrowserWindow } from "electron"
import { ipcMainHandle, isDev } from "./util.js";
import { getPreloadPath, getUIPath, getIconPath } from "./pathResolver.js";
import { getStaticData, pollResources } from "./test.js";
import dotenv from "dotenv";

dotenv.config();

const PORT = process.env.PORT || "5173"; // Default to Vite's default port

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

    if (isDev()) mainWindow.loadURL(`http://localhost:${PORT}`)
    else mainWindow.loadFile(getUIPath());

    pollResources(mainWindow);

    ipcMainHandle("getStaticData", () => {
        return getStaticData();
    })
})
