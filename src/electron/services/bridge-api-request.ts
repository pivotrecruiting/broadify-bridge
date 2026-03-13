import type { BridgeConfig } from "../types.js";

export type BridgeApiRequestFnT = (
  endpoint: string,
  options?: RequestInit,
) => Promise<unknown>;

/**
 * Resolve timeout for a bridge API endpoint.
 */
export function getBridgeApiTimeoutMs(endpoint: string): number {
  return endpoint === "/engine/connect" ? 15000 : 10000;
}

/**
 * Build bridge API URL from runtime config and endpoint.
 */
export function buildBridgeApiUrl(
  config: BridgeConfig,
  endpoint: string,
): string {
  const host = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
  return `http://${host}:${config.port}${endpoint}`;
}

/**
 * Build request headers for bridge API calls.
 */
export function buildBridgeApiHeaders(options: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  if (options.headers) {
    Object.entries(options.headers).forEach(([key, value]) => {
      if (typeof value === "string") {
        headers[key] = value;
      }
    });
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

/**
 * Create a bridge API request helper bound to a runtime config accessor.
 */
export function createBridgeApiRequest(
  getConfig: () => BridgeConfig | null,
  fetchImpl: typeof fetch = fetch,
): BridgeApiRequestFnT {
  return async (endpoint: string, options: RequestInit = {}): Promise<unknown> => {
    const config = getConfig();
    if (!config) {
      throw new Error("Bridge is not running");
    }

    const url = buildBridgeApiUrl(config, endpoint);
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      getBridgeApiTimeoutMs(endpoint),
    );

    try {
      const response = await fetchImpl(url, {
        ...options,
        signal: controller.signal,
        headers: buildBridgeApiHeaders(options),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          errorData.message || errorData.error || `HTTP ${response.status}`,
        );
      }

      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error) {
        throw error;
      }
      throw new Error("Unknown error");
    }
  };
}
