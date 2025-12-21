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

export type EventPayloadMapping = {
  statistics: Statistics;
  getStaticData: StaticData;
  bridgeStart: { success: boolean; error?: string; actualPort?: number };
  bridgeStop: { success: boolean; error?: string };
  bridgeGetStatus: BridgeStatus;
  bridgeStatus: BridgeStatus;
  checkPortAvailability: PortAvailability;
  checkPortsAvailability: PortAvailability[];
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
    };
  }
}
