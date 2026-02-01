import { useState, useEffect } from "react";
import type { BridgeStatus } from "@broadify/protocol";

/**
 * Hook to subscribe to bridge status updates
 */
export function useBridgeStatus() {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({
    running: false,
    reachable: false,
  });

  useEffect(() => {
    if (!window.electron) return;

    // Get initial status
    window.electron.bridgeGetStatus().then(setBridgeStatus);

    // Subscribe to status updates
    const unsubscribe = window.electron.subscribeBridgeStatus((status) => {
      setBridgeStatus(status);
    });

    return () => {
      unsubscribe();
    };
  }, []);

  return bridgeStatus;
}

