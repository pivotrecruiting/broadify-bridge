import { useState, useEffect, useCallback, useRef } from "react";
import type { OutputDeviceT, BridgeOutputsT } from "types";

/**
 * Hook to fetch and manage bridge outputs
 */
export function useBridgeOutputs() {
  const [outputs, setOutputs] = useState<BridgeOutputsT | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isFetchingRef = useRef(false);

  const fetchOutputs = useCallback(async () => {
    if (!window.electron) {
      setError("Electron API not available");
      return;
    }

    // Prevent concurrent fetches
    if (isFetchingRef.current) {
      return;
    }

    isFetchingRef.current = true;
    setLoading(true);
    setError(null);

    try {
      console.log("[OutputChecker] Fetching outputs from bridge...");
      const result = await window.electron.bridgeGetOutputs();
      
      const output1Count = result.output1?.length || 0;
      const output2Count = result.output2?.length || 0;
      const availableOutput1Count = result.output1?.filter((opt) => opt.available).length || 0;
      const availableOutput2Count = result.output2?.filter((opt) => opt.available).length || 0;
      
      console.log(
        `[OutputChecker] Received outputs - Output1: ${availableOutput1Count}/${output1Count} available, Output2: ${availableOutput2Count}/${output2Count} available`
      );
      
      setOutputs(result);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Failed to fetch outputs";
      setError(errorMessage);
      console.error("[OutputChecker] Error fetching outputs:", err);
    } finally {
      setLoading(false);
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    // Fetch outputs on mount
    fetchOutputs();
  }, [fetchOutputs]);

  return {
    outputs,
    loading,
    error,
    refetch: fetchOutputs,
  };
}

