import { isDev } from "./util.js"
import path from "path"
import { fileURLToPath } from "url"
import { app } from "electron"
import fs from "fs"
import {
  getPreloadPathCore,
  getUIPathCore,
  getIconPathCore,
} from "./path-resolver-core.js"

// Get __dirname equivalent for ES modules
const currentFilePath = fileURLToPath(import.meta.url)
const __dirname = path.dirname(currentFilePath)

export function getPreloadPath() {
  return getPreloadPathCore(
    __dirname,
    app.getAppPath(),
    isDev(),
    process.platform,
    fs.existsSync.bind(fs),
    process.env.BRIDGE_LOG_PRELOAD_PATH === "1"
  )
}

export function getUIPath() {
  return getUIPathCore(app.getAppPath())
}

export function getIconPath() {
  return getIconPathCore(app.getAppPath(), isDev(), process.platform)
}
