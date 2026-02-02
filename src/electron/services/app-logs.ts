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

/**
 * Return the last N lines from a log file.
 *
 * @param text Full log file content.
 * @param maxLines Max number of lines to return.
 * @returns Tail lines (up to maxLines).
 */
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

/**
 * Apply a case-insensitive filter to log lines.
 *
 * @param lines Raw log lines.
 * @param filter Optional filter string.
 * @returns Filtered lines.
 */
function applyFilter(lines: string[], filter?: string): string[] {
  if (!filter) {
    return lines;
  }
  const needle = filter.toLowerCase();
  return lines.filter((line) => line.toLowerCase().includes(needle));
}

/**
 * Read application log file with optional filtering.
 *
 * @param options Log fetch options.
 * @returns AppLogResponse with content or error.
 */
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

/**
 * Clear application log file.
 *
 * @returns AppLogClearResponseT with result or error.
 */
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
