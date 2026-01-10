import { useCallback } from "react";
import type { NetworkConfigT, NetworkBindingOptionT } from "types";
import { getBindAddress, getPortConfig } from "../utils/network-utils";

interface UseNetworkBindingParams {
  networkConfig: NetworkConfigT | null;
  networkBindingOptions: NetworkBindingOptionT[];
  networkBindingId: string;
  setNetworkBindingId: (id: string) => void;
  networkPort: string;
  setNetworkPort: (port: string) => void;
  customPort: string;
  setCustomPort: (port: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (show: boolean) => void;
}

/**
 * Hook to manage network binding state and port configuration
 */
export function useNetworkBinding({
  networkConfig,
  networkBindingOptions,
  networkBindingId,
  setNetworkBindingId,
  networkPort: _networkPort,
  setNetworkPort,
  customPort: _customPort,
  setCustomPort,
  showAdvanced: _showAdvanced,
  setShowAdvanced,
}: UseNetworkBindingParams) {
  const handleBindingChange = useCallback(
    (value: string) => {
      setNetworkBindingId(value);
      // Update port based on interface portConfig
      const option = networkBindingOptions.find((opt) => opt.id === value);

      // If "All Interfaces" is selected, automatically switch to custom port
      if (value === "all" || option?.advanced) {
        const port =
          option?.portConfig?.defaultPort ||
          networkConfig?.port.default ||
          8787;
        setCustomPort(port.toString());
        setShowAdvanced(true);
      } else if (option?.portConfig) {
        const port =
          option.portConfig.defaultPort ||
          networkConfig?.port.default ||
          8787;
        if (option.portConfig.customOnly) {
          setCustomPort(port.toString());
          setShowAdvanced(true);
        } else {
          setNetworkPort(port.toString());
          setShowAdvanced(false);
        }
      } else {
        // Fallback to global default
        const port = networkConfig?.port.default || 8787;
        setNetworkPort(port.toString());
        setShowAdvanced(false);
      }
    },
    [
      networkBindingOptions,
      networkConfig,
      setNetworkBindingId,
      setCustomPort,
      setNetworkPort,
      setShowAdvanced,
    ]
  );

  const getCurrentBindAddress = useCallback((): string => {
    return getBindAddress(networkBindingId, networkBindingOptions);
  }, [networkBindingId, networkBindingOptions]);

  const getCurrentPortConfig = useCallback(() => {
    return getPortConfig(networkBindingId, networkBindingOptions);
  }, [networkBindingId, networkBindingOptions]);

  return {
    handleBindingChange,
    getCurrentBindAddress,
    getCurrentPortConfig,
  };
}

