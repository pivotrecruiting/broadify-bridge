import electron from "electron";
import type {
  BridgeConfig,
  EventPayloadMapping,
  UnsubscribeFunction,
} from "./types.js" with { "resolution-mode": "import" };

type ElectronApi = {
  subscribeStatistics: (
    callback: (statistics: EventPayloadMapping["statistics"]) => void
  ) => UnsubscribeFunction;
  getStaticData: () => Promise<EventPayloadMapping["getStaticData"]>;
  appGetVersion: () => Promise<EventPayloadMapping["appGetVersion"]>;
  bridgeGetProfile: () => Promise<EventPayloadMapping["bridgeGetProfile"]>;
  bridgeSetName: (
    bridgeName: string
  ) => Promise<EventPayloadMapping["bridgeSetName"]>;
  bridgeStart: (
    config: BridgeConfig
  ) => Promise<EventPayloadMapping["bridgeStart"]>;
  bridgeStop: () => Promise<EventPayloadMapping["bridgeStop"]>;
  bridgeGetStatus: () => Promise<EventPayloadMapping["bridgeGetStatus"]>;
  subscribeBridgeStatus: (
    callback: (status: EventPayloadMapping["bridgeStatus"]) => void
  ) => UnsubscribeFunction;
  checkPortAvailability: (
    port: number,
    host?: string
  ) => Promise<EventPayloadMapping["checkPortAvailability"]>;
  checkPortsAvailability: (
    ports: number[],
    host?: string
  ) => Promise<EventPayloadMapping["checkPortsAvailability"]>;
  getNetworkConfig: () => Promise<EventPayloadMapping["getNetworkConfig"]>;
  detectNetworkInterfaces: () => Promise<EventPayloadMapping["detectNetworkInterfaces"]>;
  getNetworkBindingOptions: () => Promise<EventPayloadMapping["getNetworkBindingOptions"]>;
  bridgeGetOutputs: () => Promise<EventPayloadMapping["bridgeGetOutputs"]>;
  bridgeGetLogs: (options?: {
    lines?: number;
    filter?: string;
  }) => Promise<EventPayloadMapping["bridgeGetLogs"]>;
  appGetLogs: (options?: {
    lines?: number;
    filter?: string;
  }) => Promise<EventPayloadMapping["appGetLogs"]>;
  bridgeClearLogs: () => Promise<EventPayloadMapping["bridgeClearLogs"]>;
  appClearLogs: () => Promise<EventPayloadMapping["appClearLogs"]>;
  engineConnect: (
    ip?: string,
    port?: number
  ) => Promise<EventPayloadMapping["engineConnect"]>;
  engineDisconnect: () => Promise<EventPayloadMapping["engineDisconnect"]>;
  engineGetStatus: () => Promise<EventPayloadMapping["engineGetStatus"]>;
  engineGetMacros: () => Promise<EventPayloadMapping["engineGetMacros"]>;
  engineRunMacro: (
    macroId: number
  ) => Promise<EventPayloadMapping["engineRunMacro"]>;
  engineStopMacro: (
    macroId: number
  ) => Promise<EventPayloadMapping["engineStopMacro"]>;
  openExternal: (url: string) => Promise<void>;
};

// Expose a minimal, whitelisted API surface to the renderer.
electron.contextBridge.exposeInMainWorld("electron", {
  subscribeStatistics: (callback: (stats: EventPayloadMapping["statistics"]) => void) =>
    ipcOn("statistics", (stats) => {
      callback(stats);
    }),
  getStaticData: () => ipcInvoke("getStaticData"),
  appGetVersion: () => ipcInvoke("appGetVersion"),
  bridgeGetProfile: () => ipcInvoke("bridgeGetProfile"),
  bridgeSetName: (bridgeName: string) =>
    ipcInvoke("bridgeSetName", bridgeName),
  bridgeStart: (config: BridgeConfig) => ipcInvoke("bridgeStart", config),
  bridgeStop: () => ipcInvoke("bridgeStop"),
  bridgeGetStatus: () => ipcInvoke("bridgeGetStatus"),
  subscribeBridgeStatus: (
    callback: (status: EventPayloadMapping["bridgeStatus"]) => void
  ) =>
    ipcOn("bridgeStatus", (status) => {
      callback(status);
    }),
  checkPortAvailability: (port: number, host?: string) =>
    ipcInvoke("checkPortAvailability", port, host),
  checkPortsAvailability: (ports: number[], host?: string) =>
    ipcInvoke("checkPortsAvailability", ports, host),
  getNetworkConfig: () => ipcInvoke("getNetworkConfig"),
  detectNetworkInterfaces: () => ipcInvoke("detectNetworkInterfaces"),
  getNetworkBindingOptions: () => ipcInvoke("getNetworkBindingOptions"),
  bridgeGetOutputs: () => ipcInvoke("bridgeGetOutputs"),
  bridgeGetLogs: (options?: { lines?: number; filter?: string }) =>
    ipcInvoke("bridgeGetLogs", options),
  appGetLogs: (options?: { lines?: number; filter?: string }) =>
    ipcInvoke("appGetLogs", options),
  bridgeClearLogs: () => ipcInvoke("bridgeClearLogs"),
  appClearLogs: () => ipcInvoke("appClearLogs"),
  engineConnect: (ip?: string, port?: number) =>
    ipcInvoke("engineConnect", ip, port),
  engineDisconnect: () => ipcInvoke("engineDisconnect"),
  engineGetStatus: () => ipcInvoke("engineGetStatus"),
  engineGetMacros: () => ipcInvoke("engineGetMacros"),
  engineRunMacro: (macroId: number) => ipcInvoke("engineRunMacro", macroId),
  engineStopMacro: (macroId: number) => ipcInvoke("engineStopMacro", macroId),
  openExternal: (url: string) =>
    electron.ipcRenderer.invoke("openExternal", url).then(() => undefined),
} satisfies ElectronApi);

/**
 * Invoke a typed IPC handler from the renderer.
 */
function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
  ...args: any[]
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key, ...args);
}

/**
 * Subscribe to a typed IPC event from the main process.
 */
function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void
) {
  const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
  electron.ipcRenderer.on(key, cb);
  return () => electron.ipcRenderer.off(key, cb);
}
