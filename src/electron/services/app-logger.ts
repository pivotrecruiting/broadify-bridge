import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

let logStream: fs.WriteStream | null = null;

function getLogDir(): string {
  return path.join(app.getPath("userData"), "logs");
}

export function getAppLogPath(): string {
  return path.join(getLogDir(), "app.log");
}

function ensureLogStream(): fs.WriteStream {
  if (logStream) {
    return logStream;
  }
  const logDir = getLogDir();
  fs.mkdirSync(logDir, { recursive: true });
  logStream = fs.createWriteStream(getAppLogPath(), { flags: "a" });
  return logStream;
}

function writeLine(level: "INFO" | "WARN" | "ERROR", message: string): void {
  const stream = ensureLogStream();
  const timestamp = new Date().toISOString();
  stream.write(`[${timestamp}] [${level}] ${message}\n`);
}

export function logAppInfo(message: string): void {
  writeLine("INFO", message);
}

export function logAppWarn(message: string): void {
  writeLine("WARN", message);
}

export function logAppError(message: string): void {
  writeLine("ERROR", message);
}
