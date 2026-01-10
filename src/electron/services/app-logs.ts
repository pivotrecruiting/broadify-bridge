import { readFile } from "node:fs/promises";
import { getAppLogPath } from "./app-logger.js";
import type { LogFetchOptions } from "./bridge-logs.js";
import type { AppLogClearResponseT } from "../types.js";
import fs from "node:fs/promises";

export type AppLogResponse = {
  scope: "app";
  lines: number;
  content: string;
  error?: string;
};

function tailLines(text: string, maxLines: number): string[] {
  if (maxLines <= 0) {
    return [];
  }
  const lines = text.split("\n");
  if (lines.length <= maxLines) {
    return lines;
  }
  return lines.slice(lines.length - maxLines);
}

function applyFilter(lines: string[], filter?: string): string[] {
  if (!filter) {
    return lines;
  }
  const needle = filter.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

export async function readAppLogs(
  options: LogFetchOptions = {}
): Promise<AppLogResponse> {
  const maxLines = Math.min(Math.max(options.lines || 500, 1), 5000);
  try {
    const logContent = await readFile(getAppLogPath(), "utf-8");
    const rawLines = tailLines(logContent, maxLines);
    const filteredLines = applyFilter(rawLines, options.filter);

    return {
      scope: "app",
      lines: filteredLines.length,
      content: filteredLines.join("\n"),
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return {
          scope: "app",
          lines: 0,
          content: "",
        };
      }
    }
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      scope: "app",
      lines: 0,
      content: "",
      error: errorMessage,
    };
  }
}

export async function clearAppLogs(): Promise<AppLogClearResponseT> {
  try {
    await fs.writeFile(getAppLogPath(), "");
    return {
      scope: "app",
      cleared: true,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      scope: "app",
      cleared: false,
      error: errorMessage,
    };
  }
}
