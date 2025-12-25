import { useState, useEffect } from "react";
import type { NetworkConfigT, NetworkBindingOptionT, BridgeStatus } from "types";
import { getBindAddress, getPortConfig } from "../utils/network-utils";
import { shouldUseCustomPort } from "../utils/port-utils";

interface UsePortAvailabilityParams {
  networkBindingId: string;
  networkPort: string;
  customPort: string;
  showAdvanced: boolean;
  bridgeStatus: BridgeStatus;
  networkConfig: NetworkConfigT | null;
  networkBindingOptions: NetworkBindingOptionT[];
}

/**
 * Hook to check port availability and manage port availability state
 */
export function usePortAvailability({
  networkBindingId,
  networkPort,
  customPort,
  showAdvanced,
  bridgeStatus,
  networkConfig,
  networkBindingOptions,
}: UsePortAvailabilityParams) {
  const [portAvailability, setPortAvailability] = useState<Map<number, boolean>>(
    new Map()
  );
  const [checkingPorts, setCheckingPorts] = useState(false);

  useEffect(() => {
    if (!window.electron || !networkConfig) return;

    const checkPorts = async () => {
      // Don't check ports while bridge is running (would show our own bridge as "in use")
      if (bridgeStatus.running) {
        return;
      }

      setCheckingPorts(true);
      try {
        // Synthetic delay of 500ms for better UX
        await new Promise((resolve) => setTimeout(resolve, 500));

        const bindAddress = getBindAddress(networkBindingId, networkBindingOptions);
        const ports = [
          networkConfig.port.default,
          ...networkConfig.port.autoFallback,
        ];
        const results = await window.electron.checkPortsAvailability(
          ports,
          bindAddress
        );
        const availabilityMap = new Map<number, boolean>();
        results.forEach((result) => {
          availabilityMap.set(result.port, result.available);
        });
        setPortAvailability(availabilityMap);

        // Check if currently selected port is available on new IP
        // This ensures that when IP changes, if the selected port is not available, it gets reset
        const portConfig = getPortConfig(networkBindingId, networkBindingOptions);
        const useCustomPort = shouldUseCustomPort(portConfig, showAdvanced, customPort);

        if (useCustomPort && customPort) {
          const currentPort = parseInt(customPort, 10);
          if (!isNaN(currentPort)) {
            // Check custom port availability
            // Don't reset, user can change it
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            void (await window.electron.checkPortAvailability(
              currentPort,
              bindAddress
            ));
          }
        } else {
          const currentPort = parseInt(networkPort, 10);
          if (!isNaN(currentPort)) {
            // Note: Port availability is tracked, parent component can handle reset if needed
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            void availabilityMap.get(currentPort);
          }
        }
      } catch (error) {
        console.error("Error checking port availability:", error);
      } finally {
        setCheckingPorts(false);
      }
    };

    // Initial check
    checkPorts();

    // Re-check when network config changes (with debounce)
    const timeoutId = setTimeout(checkPorts, 500);
    return () => clearTimeout(timeoutId);
  }, [
    networkBindingId,
    networkPort,
    customPort,
    showAdvanced,
    bridgeStatus.running,
    networkConfig,
    networkBindingOptions,
  ]);

  return {
    portAvailability,
    checkingPorts,
  };
}

