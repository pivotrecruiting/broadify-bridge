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
  outputs?: {
    output1: string;
    output2: string;
  };
  networkBindingId?: string;
};

export type BridgeStatus = {
  running: boolean;
  reachable: boolean;
  version?: string;
  uptime?: number;
  mode?: string;
  port?: number;
  host?: string;
  state?: "idle" | "configured" | "active";
  outputsConfigured?: boolean;
  error?: string;
};

/**
 * Port status information
 */
export type PortStatusT = {
  available: boolean; // UI-Filter: present && ready && !inUse
  signal?: "none" | "detected" | "locked";
  format?: string; // Current signal format (e.g. "1080p50")
  error?: string;
};

/**
 * Port capabilities
 */
export type PortCapabilitiesT = {
  formats: string[]; // e.g. ["1080p50", "1080p60", "4K30"]
  maxResolution?: string;
};

/**
 * Device status information
 */
export type DeviceStatusT = {
  present: boolean; // Device is detected
  inUse: boolean; // Another process holds the device
  ready: boolean; // Can be opened/controlled
  signal?: "none" | "detected" | "locked";
  error?: string;
  lastSeen: number; // Timestamp
};

/**
 * Port descriptor with capabilities and status
 */
export type PortDescriptorT = {
  id: string; // Stable port ID (deviceId + portIndex)
  displayName: string; // e.g. "SDI-A", "HDMI-OUT"
  type: "sdi" | "hdmi" | "usb" | "displayport" | "thunderbolt";
  direction: "input" | "output" | "bidirectional";
  capabilities: PortCapabilitiesT;
  status: PortStatusT;
};

/**
 * Device descriptor with ports and status
 */
export type DeviceDescriptorT = {
  id: string; // Stable ID (not name!)
  displayName: string;
  type: "decklink" | "usb-capture" | "other";
  vendor?: string;
  model?: string;
  driver?: string;
  ports: PortDescriptorT[];
  status: DeviceStatusT;
};

/**
 * Output device information from bridge (UI-compatible format)
 * @deprecated Use DeviceDescriptorT for internal representation
 */
export type OutputDeviceT = {
  id: string;
  name: string;
  type: "decklink" | "capture" | "connection";
  available: boolean;
};

/**
 * Outputs response from bridge (UI-compatible format)
 * This is a view on the Device/Port model
 */
export type BridgeOutputsT = {
  output1: OutputDeviceT[];
  output2: OutputDeviceT[];
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

/**
 * Engine connection status
 */
export type EngineStatusT =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

/**
 * Macro execution status
 */
export type MacroStatusT = "idle" | "running" | "recording";

/**
 * Macro definition
 */
export type MacroT = {
  id: number;
  name: string;
  status: MacroStatusT;
};

/**
 * Engine state information
 */
export type EngineStateT = {
  status: EngineStatusT;
  type?: "atem" | "tricaster";
  ip?: string;
  port?: number;
  macros: MacroT[];
  lastUpdate?: number;
  error?: string;
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
  bridgeGetOutputs: BridgeOutputsT;
  engineConnect: { success: boolean; error?: string; state?: EngineStateT };
  engineDisconnect: { success: boolean; error?: string; state?: EngineStateT };
  engineGetStatus: { success: boolean; error?: string; state?: EngineStateT };
  engineGetMacros: { success: boolean; error?: string; macros?: MacroT[] };
  engineRunMacro: {
    success: boolean;
    error?: string;
    macroId?: number;
    state?: EngineStateT;
  };
  engineStopMacro: {
    success: boolean;
    error?: string;
    macroId?: number;
    state?: EngineStateT;
  };
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
      bridgeGetOutputs: () => Promise<BridgeOutputsT>;
      engineConnect: (
        ip?: string,
        port?: number
      ) => Promise<{ success: boolean; error?: string; state?: EngineStateT }>;
      engineDisconnect: () => Promise<{
        success: boolean;
        error?: string;
        state?: EngineStateT;
      }>;
      engineGetStatus: () => Promise<{
        success: boolean;
        error?: string;
        state?: EngineStateT;
      }>;
      engineGetMacros: () => Promise<{
        success: boolean;
        error?: string;
        macros?: MacroT[];
      }>;
      engineRunMacro: (
        macroId: number
      ) => Promise<{
        success: boolean;
        error?: string;
        macroId?: number;
        state?: EngineStateT;
      }>;
      engineStopMacro: (
        macroId: number
      ) => Promise<{
        success: boolean;
        error?: string;
        macroId?: number;
        state?: EngineStateT;
      }>;
    };
  }
}
