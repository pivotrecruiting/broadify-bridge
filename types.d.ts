export type Statistics = {
  cpuUsage: number;
  ramUsage: number;
  storageData: number;
};

export type StaticData = {
  totalStorage: number;
  cpuModel: string;
  totalMemoryGB: number;
};

export type BridgeConfig = {
  host: string;
  port: number;
};

export type BridgeStatus = {
  running: boolean;
  reachable: boolean;
  version?: string;
  uptime?: number;
  mode?: string;
  port?: number;
  host?: string;
  error?: string;
};

export type UnsubscribeFunction = () => void;

export type PortAvailability = {
  port: number;
  available: boolean;
};

/**
 * Port configuration for a specific network binding
 */
export type InterfacePortConfigT = {
  customOnly: boolean;
  defaultPort?: number;
};

/**
 * Network binding option with resolved IP address
 */
export type NetworkBindingOptionT = {
  id: string;
  label: string;
  bindAddress: string;
  interface: string;
  recommended: boolean;
  advanced: boolean;
  warning?: string;
  portConfig?: InterfacePortConfigT;
};

/**
 * Port configuration
 */
export type PortConfigT = {
  default: number;
  autoFallback: number[];
  allowCustom: boolean;
  customAdvancedOnly: boolean;
};

/**
 * Network binding configuration
 */
export type NetworkBindingConfigT = {
  default: {
    id: string;
    label: string;
    bindAddress: string;
    recommended: boolean;
    advanced: boolean;
    description: string;
  };
  options: Array<{
    id: string;
    label: string;
    bindAddress: string;
    interface: string;
    recommended: boolean;
    advanced: boolean;
    warning?: string;
    portConfig?: InterfacePortConfigT;
  }>;
  filters: {
    excludeInterfaces: string[];
    excludeIpRanges: string[];
    ipv6: boolean;
  };
};

/**
 * Complete network configuration
 */
export type NetworkConfigT = {
  networkBinding: NetworkBindingConfigT;
  port: PortConfigT;
  security: {
    lanMode: {
      enabled: boolean;
      requireAuth: boolean;
      readOnlyWithoutAuth: boolean;
    };
  };
};

export type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  bridgeStart: { success: boolean; error?: string; actualPort?: number };
  bridgeStop: { success: boolean; error?: string };
  bridgeGetStatus: BridgeStatus;
  bridgeStatus: BridgeStatus;
  checkPortAvailability: PortAvailability;
  checkPortsAvailability: PortAvailability[];
  getNetworkConfig: NetworkConfigT;
  detectNetworkInterfaces: NetworkBindingOptionT[];
  getNetworkBindingOptions: NetworkBindingOptionT[];
};

declare global {
  interface Window {
    electron: {
      subscribeStatistics: (
        callback: (statistics: Statistics) => void
      ) => UnsubscribeFunction;
      getStaticData: () => Promise<StaticData>;
      bridgeStart: (
        config: BridgeConfig
      ) => Promise<{ success: boolean; error?: string; actualPort?: number }>;
      bridgeStop: () => Promise<{ success: boolean; error?: string }>;
      bridgeGetStatus: () => Promise<BridgeStatus>;
      subscribeBridgeStatus: (
        callback: (status: BridgeStatus) => void
      ) => UnsubscribeFunction;
      checkPortAvailability: (
        port: number,
        host?: string
      ) => Promise<PortAvailability>;
      checkPortsAvailability: (
        ports: number[],
        host?: string
      ) => Promise<PortAvailability[]>;
      getNetworkConfig: () => Promise<NetworkConfigT>;
      detectNetworkInterfaces: () => Promise<NetworkBindingOptionT[]>;
      getNetworkBindingOptions: () => Promise<NetworkBindingOptionT[]>;
    };
  }
}
