export type RendererLogLevelT = "debug" | "info" | "warn" | "error";

export type ParsedRendererLogLineT = {
  level: RendererLogLevelT;
  message: string;
  context: Record<string, unknown>;
};

/**
 * Drain complete newline-separated lines from a buffer string.
 *
 * @param buffer Current stream buffer.
 * @returns Complete lines and remaining partial buffer.
 */
export function drainLines(buffer: string): {
  lines: string[];
  remainder: string;
} {
  const lines: string[] = [];
  let remainder = buffer;
  let newlineIndex = remainder.indexOf("\n");
  while (newlineIndex >= 0) {
    const line = remainder.slice(0, newlineIndex).trim();
    remainder = remainder.slice(newlineIndex + 1);
    if (line) {
      lines.push(line);
    }
    newlineIndex = remainder.indexOf("\n");
  }
  return { lines, remainder };
}

/**
 * Parse a renderer log line.
 *
 * Supports pino JSON lines and falls back to plain text lines.
 *
 * @param line Log line.
 * @param fallbackLevel Level used for non-JSON logs.
 * @returns Normalized log entry.
 */
export function parseRendererLogLine(
  line: string,
  fallbackLevel: "info" | "warn" | "error",
): ParsedRendererLogLineT {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const levelValue = typeof parsed.level === "number" ? parsed.level : null;
    const messageValue = typeof parsed.msg === "string" ? parsed.msg : line;
    const context = { ...parsed };
    delete context.level;
    delete context.msg;
    delete context.time;
    delete context.pid;
    delete context.hostname;

    if (levelValue !== null) {
      if (levelValue >= 50) {
        return { level: "error", message: messageValue, context };
      }
      if (levelValue >= 40) {
        return { level: "warn", message: messageValue, context };
      }
      if (levelValue >= 30) {
        return { level: "info", message: messageValue, context };
      }
      return { level: "debug", message: messageValue, context };
    }
  } catch {
    // Fall through to text logging.
  }

  return { level: fallbackLevel, message: line, context: {} };
}
