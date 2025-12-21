import type { NetworkBindingOptionT, InterfacePortConfigT } from "types";

/**
 * Gets the bind address for a given network binding ID
 */
export function getBindAddress(
  bindingId: string,
  options: NetworkBindingOptionT[]
): string {
  const option = options.find((opt) => opt.id === bindingId);
  return option?.bindAddress || "127.0.0.1";
}

/**
 * Gets the port configuration for a given network binding ID
 */
export function getPortConfig(
  bindingId: string,
  options: NetworkBindingOptionT[]
): InterfacePortConfigT | undefined {
  const option = options.find((opt) => opt.id === bindingId);
  return option?.portConfig;
}

/**
 * Gets the default port for a network binding
 * Falls back to global default if not specified
 */
export function getDefaultPortForBinding(
  bindingId: string,
  options: NetworkBindingOptionT[],
  globalDefault: number
): number {
  const option = options.find((opt) => opt.id === bindingId);
  return option?.portConfig?.defaultPort || globalDefault;
}

