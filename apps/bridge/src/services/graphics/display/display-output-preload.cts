import { contextBridge, ipcRenderer } from "electron";

/**
 * Frame payload delivered from the helper's main process.
 */
type DisplayFramePayloadT = {
  width: number;
  height: number;
  buffer: Uint8Array;
  timestamp?: number;
};

/**
 * Minimal, read-only API for the display helper renderer.
 *
 * Security: only exposes a single event channel (no arbitrary IPC).
 */
contextBridge.exposeInMainWorld("displayOutput", {
  /**
   * Subscribe to RGBA frame updates from the main process.
   */
  onFrame: (handler: (payload: DisplayFramePayloadT) => void) => {
    ipcRenderer.on("display-frame", (_event, payload: DisplayFramePayloadT) => {
      handler(payload);
    });
  },
});
