import type { BridgeConfig } from "../../../types.js";

const OUTPUTS_FETCH_TIMEOUT = 5000; // 5 seconds timeout

/**
 * Output device information from bridge
 */
export type OutputDeviceT = {
  id: string;
  name: string;
  type: "decklink" | "capture" | "connection";
  available: boolean;
};

/**
 * Outputs response from bridge
 */
export type BridgeOutputsT = {
  output1: OutputDeviceT[];
  output2: OutputDeviceT[];
};

/**
 * Fetch available outputs from bridge
 */
export async function fetchBridgeOutputs(
  config: BridgeConfig | null
): Promise<BridgeOutputsT | null> {
  if (!config) {
    console.log("[OutputChecker] No bridge config provided");
    return null;
  }

  try {
    // Use localhost if host is 0.0.0.0 (0.0.0.0 is not a valid target for HTTP requests)
    const fetchHost = config.host === "0.0.0.0" ? "127.0.0.1" : config.host;
    const url = `http://${fetchHost}:${config.port}/outputs`;
    console.log(`[OutputChecker] Fetching outputs from ${url}`);

    // Use fetch with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), OUTPUTS_FETCH_TIMEOUT);

    const response = await fetch(url, {
      signal: controller.signal,
      method: "GET",
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      console.log(`[OutputChecker] HTTP error ${response.status} when fetching outputs`);
      return null;
    }

    const data = await response.json() as BridgeOutputsT;
    const output1Count = data.output1?.length || 0;
    const output2Count = data.output2?.length || 0;
    console.log(
      `[OutputChecker] Successfully fetched ${output1Count} output1 devices and ${output2Count} output2 devices`
    );

    return data;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    console.log(`[OutputChecker] Failed to fetch outputs: ${errorMessage}`);
    return null;
  }
}

