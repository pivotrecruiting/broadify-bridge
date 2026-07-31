import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

/**
 * Resolve the log directory for the desktop app.
 */
export function getAppLogDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

/**
 * Resolve the log file path for the desktop app.
 */
export function getAppLogPath(): string {
  return path.join(getAppLogDir(), "app.log");
}

const MAX_APP_LOG_BYTES = 5 * 1024 * 1024;
/** Rotated files kept; older ones are deleted (WP-2.7). */
const MAX_ROTATED_APP_LOGS = 5;
/** Rotation size is checked every N writes, not per line. */
const ROTATE_CHECK_EVERY = 50;

let writesSinceRotateCheck = 0;

/**
 * Rotate the app log when it exceeds the size cap and prune old rotations.
 * Possible here (unlike the pino bridge log) because every line is written
 * with appendFileSync - no file descriptor stays open across writes.
 */
function rotateIfNeeded(): void {
  writesSinceRotateCheck += 1;
  if (writesSinceRotateCheck < ROTATE_CHECK_EVERY) {
    return;
  }
  writesSinceRotateCheck = 0;
  try {
    const logPath = getAppLogPath();
    const info = fs.statSync(logPath, { throwIfNoEntry: false });
    if (!info || info.size <= MAX_APP_LOG_BYTES) {
      return;
    }
    const logDir = getAppLogDir();
    fs.renameSync(logPath, path.join(logDir, `app-${Date.now()}.log`));
    const rotated = fs
      .readdirSync(logDir)
      .filter((name) => name.startsWith("app-") && name.endsWith(".log"))
      .sort();
    for (const name of rotated.slice(
      0,
      Math.max(0, rotated.length - MAX_ROTATED_APP_LOGS)
    )) {
      fs.unlinkSync(path.join(logDir, name));
    }
  } catch {
    // Rotation is best effort - never let it break logging itself.
  }
}

/**
 * Write a single line to the app log.
 */
function writeLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.mkdirSync(getAppLogDir(), { recursive: true });
    rotateIfNeeded();
    fs.appendFileSync(getAppLogPath(), line, "utf8");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`[AppLogger] Failed to write app log: ${errorMessage}`);
    console.error(line.trimEnd());
  }
}

/**
 * Write an INFO log entry.
 */
export function logAppInfo(message: string): void {
  writeLine("INFO", message);
}

/**
 * Write a WARN log entry.
 */
export function logAppWarn(message: string): void {
  writeLine("WARN", message);
}

/**
 * Write an ERROR log entry.
 */
export function logAppError(message: string): void {
  writeLine("ERROR", message);
}
