import { useState, useEffect, useCallback, useRef } from "react";
import type { BridgeOutputsT } from "@broadify/protocol";

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
      const result = await window.electron.bridgeGetOutputs();
      
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
