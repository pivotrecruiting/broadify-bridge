import { isDev } from "./util.js"
import path from "path"
import { fileURLToPath } from "url"
import { app } from "electron"
import fs from "fs"

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export function getPreloadPath() {
    if (isDev()) {
        // Development: preload is in project root/dist-electron
        return path.join(app.getAppPath(), "dist-electron", "preload.cjs")
    } else {
        // Production: preload is in app.asar/dist-electron
        // __dirname points to app.asar/dist-electron in packaged app
        const preloadPath = path.join(__dirname, "preload.cjs")
        
        // Sanity check: log path and existence (helpful for debugging)
        if (process.env.BRIDGE_LOG_PRELOAD_PATH === "1") {
            console.log("[Preload] Path:", preloadPath, "exists:", fs.existsSync(preloadPath))
        }
        
        return preloadPath
    }
}

export function getUIPath() {
    return path.join(app.getAppPath(), '/dist-react/index.html');
}

export function getIconPath() {
    const iconName = process.platform === 'win32' ? 'icon.png' : 'icon.png';
    return path.join(
        app.getAppPath(),
        isDev() ? './' : '../',
        `/${iconName}`
    )
}
