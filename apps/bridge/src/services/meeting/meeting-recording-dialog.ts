import { execFile } from "node:child_process";
import { platform as osPlatform } from "node:os";

import { buildDefaultRecordingPath as buildDefaultRecordingPathShared } from "../shared/recording-paths.js";

/**
 * Shows the native macOS "save file" panel via osascript and returns the chosen
 * POSIX path (with a `.mp4` extension enforced), or null if the user cancelled
 * or the platform is unsupported. The recording file is written on this machine
 * by the meeting helper, so the location must be picked here on the bridge, not
 * in the browser.
 */
const SAVE_PANEL_PROMPTS: Record<string, string> = {
  de: "Meeting-Aufnahme speichern",
  en: "Save meeting recording",
};

export async function pickRecordingSavePath(
  defaultName = "meeting.mp4",
  locale = "de",
): Promise<string | null> {
  if (osPlatform() !== "darwin") {
    // No native save panel is wired up outside macOS; returning null here made
    // the webapp treat every Windows recording as "cancelled", so recording
    // could never start. Fall back to the timestamped default path in the
    // user's standard videos folder instead of failing.
    return buildDefaultRecordingPath();
  }
  const safeName = defaultName.replace(/["\\]/g, "");
  // Match the webapp UI language; strings the OS panel shows must stay
  // localizable rather than hardcoded to one language.
  const localeKey = locale.slice(0, 2).toLowerCase();
  const prompt = SAVE_PANEL_PROMPTS[localeKey] ?? SAVE_PANEL_PROMPTS.de;
  const script = [
    "activate",
    `set theFile to choose file name with prompt "${prompt}" default name "${safeName}"`,
    "POSIX path of theFile",
  ].join("\n");

  return new Promise((resolve) => {
    execFile(
      "osascript",
      ["-e", script],
      { timeout: 120000 },
      (error, stdout) => {
        if (error) {
          // Non-zero exit means the user cancelled (-128) or the panel failed;
          // either way there is no path to record to.
          resolve(null);
          return;
        }
        const trimmed = stdout.trim();
        if (trimmed.length === 0) {
          resolve(null);
          return;
        }
        const withExtension = /\.mp4$/i.test(trimmed)
          ? trimmed
          : `${trimmed}.mp4`;
        resolve(withExtension);
      },
    );
  });
}

/**
 * Default absolute .mp4 recording path for headless triggers (Stream Deck REC
 * key) and the non-macOS save-panel fallback. Delegates to the shared
 * recording-paths helper so every trigger writes into the same folder
 * (`~/Movies/Broadify` on macOS/Linux, `~/Videos/Broadify` on Windows) with a
 * `Broadify-Meeting-<stamp>.mp4` name. Kept as a named export for callers/tests.
 */
export function buildDefaultRecordingPath(now = new Date()): string {
  return buildDefaultRecordingPathShared("meeting", now);
}
