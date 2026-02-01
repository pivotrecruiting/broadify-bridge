import type { NetworkConfigT, InterfacePortConfigT } from "@broadify/protocol";

/**
 * Validates if a port string is a valid port number (1-65535)
 */
export function validatePort(port: string): boolean {
  if (!port || port.trim() === "") {
    return false;
  }
  const portNum = parseInt(port, 10);
  return !isNaN(portNum) && portNum >= 1 && portNum <= 65535;
}

/**
 * Parses a port string to a number, returns null if invalid
 */
export function parsePort(port: string): number | null {
  if (!port || port.trim() === "") {
    return null;
  }
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return null;
  }
  return portNum;
}

/**
 * Determines if custom port should be used based on port config and advanced mode
 */
export function shouldUseCustomPort(
  portConfig: InterfacePortConfigT | undefined,
  showAdvanced: boolean,
  customPort: string
): boolean {
  return (
    Boolean(portConfig?.customOnly) ||
    (showAdvanced && Boolean(customPort && customPort.trim() !== ""))
  );
}

/**
 * Calculates which port to use based on configuration
 * Returns the port number or null if invalid
 */
export function calculatePortToUse(
  portConfig: InterfacePortConfigT | undefined,
  showAdvanced: boolean,
  customPort: string,
  networkPort: string,
  networkConfig: NetworkConfigT | null
): number | null {
  const useCustomPort = shouldUseCustomPort(portConfig, showAdvanced, customPort);

  if (useCustomPort) {
    const portValue =
      customPort ||
      portConfig?.defaultPort?.toString() ||
      networkConfig?.port.default.toString() ||
      "8787";
    
    if (!portValue || portValue.trim() === "") {
      return null;
    }
    return parsePort(portValue);
  } else {
    if (!networkPort || networkPort.trim() === "") {
      return null;
    }
    return parsePort(networkPort);
  }
}

