import { readFile, writeFile } from "node:fs/promises";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { getBridgeContext } from "../services/bridge-context.js";
import { enforceLocalOrToken } from "./route-guards.js";

type LogsQuery = {
  lines?: string;
  filter?: string;
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

export async function registerLogsRoute(
  fastify: FastifyInstance,
  _options: FastifyPluginOptions
): Promise<void> {
  // Security: log access is restricted to local requests or a shared token.
  fastify.get("/logs", async (request, reply) => {
    if (!enforceLocalOrToken(request, reply)) {
      return;
    }
    const { logPath } = getBridgeContext();
    const query = request.query as LogsQuery;
    const maxLines = Math.min(
      Math.max(parseInt(query.lines || "500", 10) || 500, 1),
      5000
    );

    try {
      const logContent = await readFile(logPath, "utf-8");
      const rawLines = tailLines(logContent, maxLines);
      const filteredLines = applyFilter(rawLines, query.filter);

      return {
        scope: "bridge",
        lines: filteredLines.length,
        content: filteredLines.join("\n"),
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Logs] Failed to read log file");
      return reply.code(500).send({
        scope: "bridge",
        error: errorMessage,
        content: "",
      });
    }
  });

  fastify.post("/logs/clear", async (_request, reply) => {
    if (!enforceLocalOrToken(_request, reply)) {
      return;
    }
    const { logPath } = getBridgeContext();
    try {
      await readFile(logPath, "utf-8");
      await writeFile(logPath, "");
      return { scope: "bridge", cleared: true };
    } catch (error) {
      if (error && typeof error === "object" && "code" in error) {
        if ((error as { code?: string }).code === "ENOENT") {
          return { scope: "bridge", cleared: true };
        }
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, "[Logs] Failed to clear log file");
      return reply.code(500).send({
        scope: "bridge",
        cleared: false,
        error: errorMessage,
      });
    }
  });
}
