import { ipcMain, WebContents, WebFrameMain } from "electron";
import { getUIPath } from "./pathResolver.js";
import { pathToFileURL } from "url";
import type { EventPayloadMapping } from "../../types.js";
import dotenv from "dotenv";

dotenv.config();
const PORT = process.env.PORT || "5173"; // Default to Vite's default port

// Checks if you are in development mode
export function isDev(): boolean {
  return process.env.NODE_ENV == "development";
}

// Making IPC Typesafe
export function ipcMainHandle<Key extends keyof EventPayloadMapping>(
  key: Key,
  handler: (
    event: Electron.IpcMainInvokeEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => EventPayloadMapping[Key] | Promise<EventPayloadMapping[Key]>
) {
  ipcMain.handle(key as string, (event, ...args) => {
    if (event.senderFrame) validateEventFrame(event.senderFrame);

    return handler(event, ...args);
  });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  webContents: WebContents,
  payload: EventPayloadMapping[Key]
) {
  webContents.send(key as string, payload);
}

export function validateEventFrame(frame: WebFrameMain) {
  if (isDev() && new URL(frame.url).host === `localhost:${PORT}`) return;

  if (frame.url !== pathToFileURL(getUIPath()).toString())
    throw new Error("Malicious event");
}
