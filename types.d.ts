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

export type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  bridgeStart: { success: boolean; error?: string };
  bridgeStop: { success: boolean; error?: string };
  bridgeGetStatus: BridgeStatus;
  bridgeStatus: BridgeStatus;
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
      ) => Promise<{ success: boolean; error?: string }>;
      bridgeStop: () => Promise<{ success: boolean; error?: string }>;
      bridgeGetStatus: () => Promise<BridgeStatus>;
      subscribeBridgeStatus: (
        callback: (status: BridgeStatus) => void
      ) => UnsubscribeFunction;
    };
  }
}
