import os from "os";

/**
 * Network interface information
 */
export interface NetworkInterfaceInfo {
  name: string;
  address: string;
  family: "IPv4" | "IPv6";
  internal: boolean;
}

/**
 * Port configuration for a specific network binding
 */
export interface InterfacePortConfig {
  customOnly: boolean;
  defaultPort?: number;
}

/**
 * Network binding option with resolved IP address
 */
export interface NetworkBindingOption {
  id: string;
  label: string;
  bindAddress: string;
  interface: string;
  recommended: boolean;
  advanced: boolean;
  warning?: string;
  portConfig?: InterfacePortConfig;
}

/**
 * Configuration for interface filtering
 */
export interface InterfaceFilterConfig {
  excludeInterfaces: string[];
  excludeIpRanges: string[];
  ipv6: boolean;
}

/**
 * Check if an IP address is in an excluded range
 */
function isIpInRange(ip: string, range: string): boolean {
  if (range === "169.254.0.0/16") {
    // Link-local range
    const parts = ip.split(".");
    if (parts.length !== 4) return false;
    const first = parseInt(parts[0], 10);
    const second = parseInt(parts[1], 10);
    return first === 169 && second === 254;
  }
  // Add more range checks if needed
  return false;
}

/**
 * Check if an interface name should be excluded
 */
function shouldExcludeInterface(
  name: string,
  excludeInterfaces: string[]
): boolean {
  const lowerName = name.toLowerCase();
  return excludeInterfaces.some((excluded) =>
    lowerName.includes(excluded.toLowerCase())
  );
}

/**
 * Detect network interfaces and return available options
 */
export function detectNetworkInterfaces(
  configOptions: Array<{
    id: string;
    label: string;
    bindAddress: string;
    interface: string;
    recommended: boolean;
    advanced: boolean;
    warning?: string;
    portConfig?: InterfacePortConfig;
  }>,
  filters: InterfaceFilterConfig
): NetworkBindingOption[] {
  const interfaces = os.networkInterfaces();
  const result: NetworkBindingOption[] = [];

  // Helper to find IPv4 address for a specific interface type
  const findInterfaceIp = (interfaceType: string): string | null => {
    if (interfaceType === "loopback") {
      return "127.0.0.1";
    }
    if (interfaceType === "all") {
      return "0.0.0.0";
    }

    // Find interfaces matching the type (ethernet, wifi)
    for (const [name, addrs] of Object.entries(interfaces || {})) {
      if (!addrs) continue;

      // Skip excluded interfaces
      if (shouldExcludeInterface(name, filters.excludeInterfaces)) {
        continue;
      }

      // Determine if this interface matches the type
      const lowerName = name.toLowerCase();
      let matchesType = false;

      if (interfaceType === "ethernet") {
        // Common ethernet interface names
        matchesType =
          lowerName.includes("eth") ||
          lowerName.includes("en") ||
          lowerName.includes("ethernet") ||
          lowerName.includes("lan");
      } else if (interfaceType === "wifi") {
        // Common wifi interface names
        matchesType =
          lowerName.includes("wifi") ||
          lowerName.includes("wlan") ||
          lowerName.includes("wi-fi") ||
          lowerName.includes("wireless");
      }

      if (!matchesType) continue;

      // Find first IPv4 address that's not excluded
      for (const addr of addrs) {
        if (!addr) continue;

        // Skip IPv6 if not allowed
        if (!filters.ipv6 && addr.family === "IPv6") {
          continue;
        }

        // Only use IPv4
        if (addr.family !== "IPv4") {
          continue;
        }

        // Skip internal addresses (loopback)
        if (addr.internal) {
          continue;
        }

        // Skip excluded IP ranges
        if (filters.excludeIpRanges.some((range) => isIpInRange(addr.address, range))) {
          continue;
        }

        return addr.address;
      }
    }

    return null;
  };

  // Process each config option
  for (const option of configOptions) {
    let bindAddress = option.bindAddress;

    // Resolve AUTO_IPV4 to actual IP address
    if (bindAddress === "AUTO_IPV4") {
      const detectedIp = findInterfaceIp(option.interface);
      if (detectedIp) {
        bindAddress = detectedIp;
      } else {
        // Skip this option if no IP could be detected
        continue;
      }
    }

    result.push({
      id: option.id,
      label: option.label,
      bindAddress,
      interface: option.interface,
      recommended: option.recommended,
      advanced: option.advanced,
      warning: option.warning,
      portConfig: option.portConfig,
    });
  }

  return result;
}

/**
 * Resolve bind address to actual IP address
 * Handles AUTO_IPV4, 0.0.0.0, and other special cases
 */
export function resolveBindAddress(
  bindAddress: string,
  interfaceType: string,
  filters?: InterfaceFilterConfig
): string {
  // If already a specific IP, return as-is
  if (bindAddress !== "AUTO_IPV4" && bindAddress !== "0.0.0.0") {
    return bindAddress;
  }

  const interfaces = os.networkInterfaces();
  const defaultFilters: InterfaceFilterConfig = {
    excludeInterfaces: filters?.excludeInterfaces || [],
    excludeIpRanges: filters?.excludeIpRanges || [],
    ipv6: filters?.ipv6 || false,
  };

  // Handle loopback
  if (interfaceType === "loopback") {
    return "127.0.0.1";
  }

  // Handle "all" interfaces - find primary IPv4 address
  if (bindAddress === "0.0.0.0" || interfaceType === "all") {
    // Find first non-excluded, non-internal IPv4 address
    for (const [name, addrs] of Object.entries(interfaces || {})) {
      if (!addrs) continue;

      if (shouldExcludeInterface(name, defaultFilters.excludeInterfaces)) {
        continue;
      }

      for (const addr of addrs) {
        if (!addr) continue;

        if (!defaultFilters.ipv6 && addr.family === "IPv6") {
          continue;
        }

        if (addr.family !== "IPv4") {
          continue;
        }

        if (addr.internal) {
          continue;
        }

        if (
          defaultFilters.excludeIpRanges.some((range) =>
            isIpInRange(addr.address, range)
          )
        ) {
          continue;
        }

        return addr.address;
      }
    }
    // Fallback to localhost if no external IP found
    return "127.0.0.1";
  }

  // Handle AUTO_IPV4 - find IP for specific interface type
  if (bindAddress === "AUTO_IPV4") {
    // Find interfaces matching the type (ethernet, wifi)
    for (const [name, addrs] of Object.entries(interfaces || {})) {
      if (!addrs) continue;

      if (shouldExcludeInterface(name, defaultFilters.excludeInterfaces)) {
        continue;
      }

      const lowerName = name.toLowerCase();
      let matchesType = false;

      if (interfaceType === "ethernet") {
        matchesType =
          lowerName.includes("eth") ||
          lowerName.includes("en") ||
          lowerName.includes("ethernet") ||
          lowerName.includes("lan");
      } else if (interfaceType === "wifi") {
        matchesType =
          lowerName.includes("wifi") ||
          lowerName.includes("wlan") ||
          lowerName.includes("wi-fi") ||
          lowerName.includes("wireless");
      }

      if (!matchesType) continue;

      // Find first IPv4 address that's not excluded
      for (const addr of addrs) {
        if (!addr) continue;

        if (!defaultFilters.ipv6 && addr.family === "IPv6") {
          continue;
        }

        if (addr.family !== "IPv4") {
          continue;
        }

        if (addr.internal) {
          continue;
        }

        if (
          defaultFilters.excludeIpRanges.some((range) =>
            isIpInRange(addr.address, range)
          )
        ) {
          continue;
        }

        return addr.address;
      }
    }

    // Fallback to localhost if no IP found
    return "127.0.0.1";
  }

  // Fallback
  return bindAddress;
}

