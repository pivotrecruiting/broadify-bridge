import { useState, useEffect } from "react";
import type { NetworkConfigT, NetworkBindingOptionT } from "types";
import { getDefaultPortForBinding } from "../utils/network-utils";

/**
 * Hook to load and manage network configuration
 */
export function useNetworkConfig() {
  const [networkConfig, setNetworkConfig] = useState<NetworkConfigT | null>(null);
  const [networkBindingOptions, setNetworkBindingOptions] = useState<
    NetworkBindingOptionT[]
  >([]);
  const [networkBindingId, setNetworkBindingId] = useState<string>("localhost");
  const [networkPort, setNetworkPort] = useState<string>("8787");
  const [customPort, setCustomPort] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!window.electron) return;

    const loadConfig = async () => {
      try {
        const config = await window.electron.getNetworkConfig();
        setNetworkConfig(config);
        setNetworkBindingId(config.networkBinding.default.id);

        // Load network binding options with detected interfaces
        const options = await window.electron.getNetworkBindingOptions();
        setNetworkBindingOptions(options);

        // Set default port from interface portConfig or global default
        const defaultOption = options.find(
          (opt) => opt.id === config.networkBinding.default.id
        );
        const defaultPort = getDefaultPortForBinding(
          config.networkBinding.default.id,
          options,
          config.port.default
        );

        // If "All Interfaces" is selected or portConfig requires customOnly, use custom port
        if (
          config.networkBinding.default.id === "all" ||
          defaultOption?.advanced ||
          defaultOption?.portConfig?.customOnly
        ) {
          setCustomPort(defaultPort.toString());
          setShowAdvanced(true);
        } else {
          setNetworkPort(defaultPort.toString());
          setShowAdvanced(false);
        }
      } catch (error) {
        console.error("Error loading network config:", error);
      }
    };

    loadConfig();
  }, []);

  return {
    networkConfig,
    networkBindingOptions,
    networkBindingId,
    setNetworkBindingId,
    networkPort,
    setNetworkPort,
    customPort,
    setCustomPort,
    showAdvanced,
    setShowAdvanced,
  };
}

