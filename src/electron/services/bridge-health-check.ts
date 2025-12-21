import type { BridgeConfig, BridgeStatus } from "../../../types.js";

const HEALTH_CHECK_INTERVAL = 2000; // 2 seconds
const HEALTH_CHECK_TIMEOUT = 3000; // 3 seconds timeout

/**
 * Check bridge health by calling /status endpoint
 */
export async function checkBridgeHealth(
  config: BridgeConfig | null
): Promise<BridgeStatus> {
  if (!config) {
    return {
      running: false,
      reachable: false,
      error: "No bridge configuration",
    };
  }

  try {
    const url = `http://${config.host}:${config.port}/status`;

    // Use fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        running: false,
        reachable: false,
        error: `HTTP ${response.status}`,
      };
    }

    const data = await response.json();

    return {
      running: true,
      reachable: true,
      version: data.version,
      uptime: data.uptime,
      mode: data.mode,
      port: data.port,
      host: data.host,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      running: false,
      reachable: false,
      error: errorMessage,
    };
  }
}

/**
 * Start health check polling
 */
export function startHealthCheckPolling(
  config: BridgeConfig | null,
  onStatusUpdate: (status: BridgeStatus) => void
): () => void {
  let intervalId: NodeJS.Timeout | null = null;

  const poll = async () => {
    const status = await checkBridgeHealth(config);
    onStatusUpdate(status);
  };

  // Initial check
  poll();

  // Start polling
  intervalId = setInterval(poll, HEALTH_CHECK_INTERVAL);

  // Return cleanup function
  return () => {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
}

