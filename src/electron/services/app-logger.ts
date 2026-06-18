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

/**
 * Write a single line to the app log.
 */
function writeLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level}] ${message}\n`;
  try {
    fs.mkdirSync(getAppLogDir(), { recursive: true });
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
