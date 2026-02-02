/**
 * Shared protocol types for Bridge and Desktop integration.
 */
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
    userDataDir?: string;
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
    relayConnected?: boolean;
    bridgeId?: string;
    bridgeName?: string;
    webAppUrl?: string;
    pairingCode?: string;
    pairingExpiresAt?: string;
    pairingExpired?: boolean;
};
/**
 * Port status information
 */
export type PortStatusT = {
    available: boolean;
    signal?: "none" | "detected" | "locked";
    format?: string;
    error?: string;
};
/**
 * Port capabilities
 */
export type PortCapabilitiesT = {
    formats: string[];
    maxResolution?: string;
    modes?: OutputDisplayModeT[];
};
/**
 * Device status information
 */
export type DeviceStatusT = {
    present: boolean;
    inUse: boolean;
    ready: boolean;
    signal?: "none" | "detected" | "locked";
    error?: string;
    lastSeen: number;
};
/**
 * Port descriptor with capabilities and status
 */
export type PortDescriptorT = {
    id: string;
    displayName: string;
    type: "sdi" | "hdmi" | "usb" | "displayport" | "thunderbolt";
    direction: "input" | "output" | "bidirectional";
    role?: "fill" | "key" | "video";
    capabilities: PortCapabilitiesT;
    status: PortStatusT;
};
/**
 * Device descriptor with ports and status
 */
export type DeviceDescriptorT = {
    id: string;
    displayName: string;
    type: "usb-capture" | "decklink" | "other";
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
    deviceId?: string;
    portType?: PortDescriptorT["type"];
    portRole?: PortDescriptorT["role"];
    formats?: string[];
    modes?: OutputDisplayModeT[];
};
export type OutputDisplayModeT = {
    id: number;
    label: string;
    width: number;
    height: number;
    fps: number;
    fieldDominance: string;
    pixelFormats: string[];
};
/**
 * Outputs response from bridge (UI-compatible format)
 * This is a view on the Device/Port model
 */
export type BridgeOutputsT = {
    output1: OutputDeviceT[];
    output2: OutputDeviceT[];
};
export type LogFetchOptionsT = {
    lines?: number;
    filter?: string;
};
export type BridgeLogResponseT = {
    scope: "bridge";
    lines: number;
    content: string;
    error?: string;
};
export type BridgeLogClearResponseT = {
    scope: "bridge";
    cleared: boolean;
    error?: string;
};
export type AppLogResponseT = {
    scope: "app";
    lines: number;
    content: string;
    error?: string;
};
export type AppLogClearResponseT = {
    scope: "app";
    cleared: boolean;
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
/**
 * Engine connection status
 */
export type EngineStatusT = "disconnected" | "connecting" | "connected" | "error";
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
