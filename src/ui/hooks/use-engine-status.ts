import { useState, useEffect, useCallback } from "react";
import type { EngineStateT } from "@broadify/protocol";

/**
 * Hook to manage engine connection status
 */
export function useEngineStatus() {
  const [engineState, setEngineState] = useState<EngineStateT>({
    status: "disconnected",
    macros: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch engine status from bridge
   */
  const fetchStatus = useCallback(async () => {
    if (!window.electron) return;

    try {
      setLoading(true);
      setError(null);
      const result = await window.electron.engineGetStatus();
      if (result.success && result.state) {
        setEngineState(result.state);
      } else {
        setError(result.error || "Failed to get engine status");
        if (result.state) {
          setEngineState(result.state);
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Connect to engine
   */
  const connect = useCallback(
    async (ip?: string, port?: number) => {
      if (!window.electron) return;

      try {
        setLoading(true);
        setError(null);
        const result = await window.electron.engineConnect(ip, port);
        if (result.success && result.state) {
          setEngineState(result.state);
        } else {
          setError(result.error || "Failed to connect to engine");
          if (result.state) {
            setEngineState(result.state);
          }
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Unknown error";
        setError(errorMessage);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  /**
   * Disconnect from engine
   */
  const disconnect = useCallback(async () => {
    if (!window.electron) return;

    try {
      setLoading(true);
      setError(null);
      const result = await window.electron.engineDisconnect();
      if (result.success && result.state) {
        setEngineState(result.state);
      } else {
        setError(result.error || "Failed to disconnect from engine");
        if (result.state) {
          setEngineState(result.state);
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  // Poll engine status when connected
  useEffect(() => {
    if (engineState.status !== "connected") return;

    // Initial fetch
    fetchStatus();

    // Poll every 2 seconds when connected
    const interval = setInterval(() => {
      fetchStatus();
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [engineState.status, fetchStatus]);

  // Initial fetch on mount
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  return {
    engineState,
    loading,
    error,
    connect,
    disconnect,
    refetch: fetchStatus,
  };
}

