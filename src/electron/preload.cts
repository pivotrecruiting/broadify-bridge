import electron from "electron";
import type {
  BridgeConfig,
  EventPayloadMapping,
} from "../../types.js" with { "resolution-mode": "import" };

electron.contextBridge.exposeInMainWorld("electron", {
  subscribeStatistics: (callback) =>
    ipcOn("statistics", (stats) => {
      callback(stats);
    }),
  getStaticData: () => ipcInvoke("getStaticData"),
  bridgeStart: (config: BridgeConfig) => ipcInvoke("bridgeStart", config),
  bridgeStop: () => ipcInvoke("bridgeStop"),
  bridgeGetStatus: () => ipcInvoke("bridgeGetStatus"),
  subscribeBridgeStatus: (callback) =>
    ipcOn("bridgeStatus", (status) => {
      callback(status);
    }),
  checkPortAvailability: (port: number, host?: string) =>
    ipcInvoke("checkPortAvailability", port, host),
  checkPortsAvailability: (ports: number[], host?: string) =>
    ipcInvoke("checkPortsAvailability", ports, host),
} satisfies Window["electron"]);

function ipcInvoke<Key extends keyof EventPayloadMapping>(
  key: Key,
  ...args: any[]
): Promise<EventPayloadMapping[Key]> {
  return electron.ipcRenderer.invoke(key, ...args);
}

function ipcOn<Key extends keyof EventPayloadMapping>(
  key: Key,
  callback: (payload: EventPayloadMapping[Key]) => void
) {
  const cb = (_: Electron.IpcRendererEvent, payload: any) => callback(payload);
  electron.ipcRenderer.on(key, cb);
  return () => electron.ipcRenderer.off(key, cb);
}
