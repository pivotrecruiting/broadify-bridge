import type {
  AppLogClearResponseT,
  AppLogResponseT,
  BridgeConfig,
  BridgeLogClearResponseT,
  BridgeLogResponseT,
  BridgeOutputsT,
  BridgeStatus,
  EngineStateT,
  LogFetchOptionsT,
  MacroT,
  NetworkBindingOptionT,
  NetworkConfigT,
  PortAvailability,
  StaticData,
  Statistics,
  UnsubscribeFunction,
} from "@broadify/protocol";

declare global {
  interface Window {
    electron: {
      subscribeStatistics: (
        callback: (statistics: Statistics) => void
      ) => UnsubscribeFunction;
      getStaticData: () => Promise<StaticData>;
      /**
       * Get the desktop application version.
       */
      appGetVersion: () => Promise<string>;
      bridgeGetProfile: () => Promise<{
        bridgeId: string;
        bridgeName: string | null;
      }>;
      bridgeSetName: (bridgeName: string) => Promise<{
        success: boolean;
        error?: string;
      }>;
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
      bridgeGetLogs: (options?: LogFetchOptionsT) => Promise<BridgeLogResponseT>;
      appGetLogs: (options?: LogFetchOptionsT) => Promise<AppLogResponseT>;
      bridgeClearLogs: () => Promise<BridgeLogClearResponseT>;
      appClearLogs: () => Promise<AppLogClearResponseT>;
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
      engineRunMacro: (macroId: number) => Promise<{
        success: boolean;
        error?: string;
        macroId?: number;
        state?: EngineStateT;
      }>;
      engineStopMacro: (macroId: number) => Promise<{
        success: boolean;
        error?: string;
        macroId?: number;
        state?: EngineStateT;
      }>;
      openExternal: (url: string) => Promise<void>;
    };
  }
}

export {};
