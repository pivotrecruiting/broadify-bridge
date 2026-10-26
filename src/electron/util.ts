import { app, ipcMain, WebContents, WebFrameMain } from "electron";
import { getUIPath } from "./pathResolver.js";
import { pathToFileURL } from "url";
import { loadAppEnv } from "./services/env-loader.js";
import type { EventPayloadMapping } from "./types.js";

loadAppEnv();
const PORT = process.env.PORT || "5173"; // Default to Vite's default port

/**
 * Check whether the app runs in development mode.
 *
 * Both conditions must hold: `NODE_ENV=development` (set by `dev:electron`)
 * and an unpackaged app. A packaged build is never treated as dev, even if a
 * stray `NODE_ENV=development` leaks into its environment (e.g. on a support
 * machine), so it never falls back to dev-only spawning or cwd-relative files.
 */
export function isDev(): boolean {
  return process.env.NODE_ENV === "development" && !app.isPackaged;
}

// Making IPC Typesafe
export function ipcMainHandle<Key extends keyof EventPayloadMapping>(
  key: Key,
  handler: (
    event: Electron.IpcMainInvokeEvent,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...args: any[]
  ) => EventPayloadMapping[Key] | Promise<EventPayloadMapping[Key]>,
) {
  ipcMain.handle(key as string, (event, ...args) => {
    if (event.senderFrame) validateEventFrame(event.senderFrame);

    return handler(event, ...args);
  });
}

export function ipcWebContentsSend<Key extends keyof EventPayloadMapping>(
  key: Key,
  webContents: WebContents,
  payload: EventPayloadMapping[Key],
) {
  webContents.send(key as string, payload);
}

export function validateEventFrame(frame: WebFrameMain) {
  if (isDev() && new URL(frame.url).host === `localhost:${PORT}`) return;

  if (frame.url !== pathToFileURL(getUIPath()).toString())
    throw new Error("Malicious event");
}
