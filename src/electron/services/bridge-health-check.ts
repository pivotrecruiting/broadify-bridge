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
    console.log("[HealthCheck] No config provided");
    return {
      running: false,
      reachable: false,
      error: "No bridge configuration",
    };
  }

  try {
    // Use localhost if host is 0.0.0.0 (0.0.0.0 is not a valid target for HTTP requests)
    const healthCheckHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = `http://${healthCheckHost}:${config.port}/status`;
    console.log(`[HealthCheck] Checking bridge health at ${url} (original host: ${config.host})`);

    // Use fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`[HealthCheck] HTTP error: ${response.status}`);
      return {
        running: false,
        reachable: false,
        error: `HTTP ${response.status}`,
      };
    }

    // Check content type to detect if we got HTML instead of JSON
    const contentType = response.headers.get("content-type");
    console.log(`[HealthCheck] Response content-type: ${contentType}`);
    
    if (contentType && !contentType.includes("application/json")) {
      const text = await response.text();
      console.log(`[HealthCheck] Got non-JSON response (first 100 chars): ${text.substring(0, 100)}`);
      return {
        running: false,
        reachable: false,
        error: `Port ${config.port} is already in use by another service`,
      };
    }

    const data = await response.json();
    console.log(`[HealthCheck] Bridge is healthy:`, data);

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
    let errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    
    // Check if error is JSON parse error (likely HTML response)
    if (errorMessage.includes("JSON") || errorMessage.includes("<!doctype")) {
      errorMessage = `Port ${config.port} is already in use by another service`;
    }
    
    console.log(`[HealthCheck] Health check failed:`, errorMessage);
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
  onStatusUpdate: (status: BridgeStatus) => void,
  isProcessRunning?: () => boolean
): () => void {
  let intervalId: NodeJS.Timeout | null = null;

  const poll = async () => {
    console.log(`[HealthCheck] Polling bridge health (config: ${config?.host}:${config?.port})`);
    const healthStatus = await checkBridgeHealth(config);
    
    // If process is running, ensure running is true even if health check failed
    const processRunning = isProcessRunning ? isProcessRunning() : true;
    const status: BridgeStatus = {
      ...healthStatus,
      running: processRunning, // Use actual process state
    };
    
    console.log(`[HealthCheck] Poll result (processRunning: ${processRunning}):`, status);
    onStatusUpdate(status);
  };

  // Initial check
  console.log(`[HealthCheck] Starting health check polling`);
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

