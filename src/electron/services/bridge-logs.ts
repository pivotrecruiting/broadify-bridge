import type { BridgeConfig } from "../types.js";

const LOGS_FETCH_TIMEOUT = 5000;

export type LogFetchOptions = {
  lines?: number;
  filter?: string;
};

export type LogResponse = {
  scope: "bridge";
  lines: number;
  content: string;
  error?: string;
};

export type LogClearResponse = {
  scope: "bridge";
  cleared: boolean;
  error?: string;
};

export async function fetchBridgeLogs(
  config: BridgeConfig | null,
  options: LogFetchOptions = {}
): Promise<LogResponse> {
  if (!config) {
    return {
      scope: "bridge",
      lines: 0,
      content: "",
      error: "No bridge config available",
    };
  }

  try {
    const fetchHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = new URL(`http://${fetchHost}:${config.port}/logs`);
    if (options.lines) {
      url.searchParams.set("lines", options.lines.toString());
    }
    if (options.filter) {
      url.searchParams.set("filter", options.filter);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOGS_FETCH_TIMEOUT);

    const response = await fetch(url.toString(), {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        scope: "bridge",
        lines: 0,
        content: "",
        error: `HTTP ${response.status}`,
      };
    }

    return (await response.json()) as LogResponse;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      scope: "bridge",
      lines: 0,
      content: "",
      error: errorMessage,
    };
  }
}

export async function clearBridgeLogs(
  config: BridgeConfig | null
): Promise<LogClearResponse> {
  if (!config) {
    return {
      scope: "bridge",
      cleared: false,
      error: "No bridge config available",
    };
  }

  try {
    const fetchHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = `http://${fetchHost}:${config.port}/logs/clear`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LOGS_FETCH_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "POST",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        scope: "bridge",
        cleared: false,
        error: `HTTP ${response.status}`,
      };
    }

    return (await response.json()) as LogClearResponse;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      scope: "bridge",
      cleared: false,
      error: errorMessage,
    };
  }
}
