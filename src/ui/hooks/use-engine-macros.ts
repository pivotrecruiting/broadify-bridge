import { useState, useEffect, useCallback } from "react";
import type { MacroT } from "types";

/**
 * Hook to manage engine macros
 */
export function useEngineMacros() {
  const [macros, setMacros] = useState<MacroT[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Fetch macros from engine
   */
  const fetchMacros = useCallback(async () => {
    if (!window.electron) return;

    try {
      setLoading(true);
      setError(null);
      const result = await window.electron.engineGetMacros();
      if (result.success && result.macros) {
        setMacros(result.macros);
      } else {
        setError(result.error || "Failed to get macros");
        setMacros(result.macros || []);
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      setMacros([]);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Run a macro
   */
  const runMacro = useCallback(async (macroId: number) => {
    if (!window.electron) return;

    try {
      setLoading(true);
      setError(null);
      const result = await window.electron.engineRunMacro(macroId);
      if (result.success) {
        // Refresh macros to get updated status
        await fetchMacros();
      } else {
        setError(result.error || "Failed to run macro");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [fetchMacros]);

  /**
   * Stop a macro
   */
  const stopMacro = useCallback(async (macroId: number) => {
    if (!window.electron) return;

    try {
      setLoading(true);
      setError(null);
      const result = await window.electron.engineStopMacro(macroId);
      if (result.success) {
        // Refresh macros to get updated status
        await fetchMacros();
      } else {
        setError(result.error || "Failed to stop macro");
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [fetchMacros]);

  // Initial fetch on mount
  useEffect(() => {
    fetchMacros();
  }, [fetchMacros]);

  return {
    macros,
    loading,
    error,
    runMacro,
    stopMacro,
    refetch: fetchMacros,
  };
}

