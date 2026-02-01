import type {
  AppLogClearResponseT,
  AppLogResponseT,
  BridgeLogClearResponseT,
  BridgeLogResponseT,
  BridgeOutputsT,
  BridgeStatus,
  EngineStateT,
  MacroT,
  NetworkBindingOptionT,
  NetworkConfigT,
  PortAvailability,
  StaticData,
  Statistics,
} from "@broadify/protocol";

export type {
  AppLogClearResponseT,
  AppLogResponseT,
  BridgeConfig,
  BridgeLogClearResponseT,
  BridgeLogResponseT,
  BridgeOutputsT,
  BridgeStatus,
  DeviceDescriptorT,
  DeviceStatusT,
  EngineStateT,
  EngineStatusT,
  InterfacePortConfigT,
  LogFetchOptionsT,
  MacroStatusT,
  MacroT,
  NetworkBindingConfigT,
  NetworkBindingOptionT,
  NetworkConfigT,
  OutputDeviceT,
  OutputDisplayModeT,
  PortAvailability,
  PortCapabilitiesT,
  PortConfigT,
  PortDescriptorT,
  PortStatusT,
  StaticData,
  Statistics,
  UnsubscribeFunction,
} from "@broadify/protocol";

export type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  appGetVersion: string;
  bridgeGetProfile: { bridgeId: string; bridgeName: string | null };
  bridgeSetName: { success: boolean; error?: string };
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
  bridgeGetLogs: BridgeLogResponseT;
  appGetLogs: AppLogResponseT;
  bridgeClearLogs: BridgeLogClearResponseT;
  appClearLogs: AppLogClearResponseT;
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
  openExternal: void;
};
