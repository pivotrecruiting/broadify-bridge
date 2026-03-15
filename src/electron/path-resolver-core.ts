import path from "path";

/**
 * Core path resolution logic, testable without import.meta.
 *
 * @param dirname Directory of the pathResolver module (for production preload path).
 * @param appPath Result of app.getAppPath().
 * @param isDev Whether running in development mode.
 * @param platform process.platform.
 * @param existsSync fs.existsSync function.
 * @param logPreloadPath Whether to log preload path (BRIDGE_LOG_PRELOAD_PATH=1).
 */
export function getPreloadPathCore(
  dirname: string,
  appPath: string,
  isDev: boolean,
  platform: string,
  existsSync: (p: string) => boolean,
  logPreloadPath: boolean
): string {
  if (isDev) {
    return path.join(appPath, "dist-electron", "preload.cjs");
  }
  const preloadPath = path.join(dirname, "preload.cjs");
  if (logPreloadPath) {
    console.log("[Preload] Path:", preloadPath, "exists:", existsSync(preloadPath));
  }
  return preloadPath;
}

export function getUIPathCore(appPath: string): string {
  return path.join(appPath, "/dist-react/index.html");
}

export function getIconPathCore(
  appPath: string,
  isDev: boolean,
  platform: string
): string {
  const iconName = platform === "win32" ? "icon.png" : "icon.png";
  return path.join(appPath, isDev ? "./" : "../", `/${iconName}`);
}
