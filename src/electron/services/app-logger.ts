import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

let logStream: fs.WriteStream | null = null;

/**
 * Resolve the log directory for the desktop app.
 */
function getLogDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

/**
 * Resolve the log file path for the desktop app.
 */
export function getAppLogPath(): string {
  return path.join(getLogDir(), "app.log");
}

/**
 * Ensure a writable log stream is created.
 */
function ensureLogStream(): fs.WriteStream {
  if (logStream) {
    return logStream;
  }
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  logStream = fs.createWriteStream(getAppLogPath(), { flags: "a" });
  return logStream;
}

/**
 * Write a single line to the app log.
 */
function writeLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const stream = ensureLogStream();
  const timestamp = new Date().toISOString();
  stream.write(`[${timestamp}] [${level}] ${message}\n`);
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
