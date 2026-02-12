import fs from "node:fs";
import path from "node:path";

const ELECTRON_BINARIES = {
  win32: "electron.cmd",
  default: "electron",
};

const formatStatMode = (mode: number): string => {
  return `0${(mode & 0o777).toString(8)}`;
};

/**
 * Describe a binary path for diagnostics.
 *
 * @param filePath Candidate binary path.
 * @returns Human-readable state summary.
 */
export function describeBinary(filePath: string): string {
  if (!filePath) {
    return "path is empty";
  }
  if (!fs.existsSync(filePath)) {
    return `missing (${filePath})`;
  }
  try {
    const stat = fs.statSync(filePath);
    return `path=${filePath} size=${stat.size} mode=${formatStatMode(stat.mode)}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `unreadable (${filePath}): ${message}`;
  }
}

/**
 * Resolve Electron binary for launching the offscreen renderer process.
 *
 * @returns Absolute binary path or null when unavailable.
 */
export function resolveElectronBinary(): string | null {
  if (process.env.ELECTRON_RUN_AS_NODE === "1") {
    return process.execPath;
  }

  if (process.execPath.toLowerCase().includes("electron")) {
    return process.execPath;
  }

  const binaryName =
    process.platform === "win32"
      ? ELECTRON_BINARIES.win32
      : ELECTRON_BINARIES.default;

  const candidate = path.resolve(
    process.cwd(),
    "..",
    "..",
    "node_modules",
    ".bin",
    binaryName,
  );

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  return null;
}

/**
 * Resolve built renderer entry file path.
 *
 * @returns Absolute entry file path or null when unavailable.
 */
export function resolveRendererEntry(): string | null {
  const distEntry = path.resolve(
    process.cwd(),
    "dist",
    "services",
    "graphics",
    "renderer",
    "electron-renderer-entry.js",
  );
  if (fs.existsSync(distEntry)) {
    return distEntry;
  }

  return null;
}
