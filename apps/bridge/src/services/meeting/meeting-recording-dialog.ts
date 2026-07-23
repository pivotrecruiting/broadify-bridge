import { execFile } from "node:child_process";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

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
    return null;
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
 * Builds a default absolute .mp4 recording path for headless triggers (e.g. the
 * Stream Deck REC key) that cannot open the native save panel. Writes into the
 * user's standard Movies (macOS/Linux) or Videos (Windows) folder with a
 * timestamped file name. The result is a well-formed absolute .mp4 path with no
 * parent traversal, so it passes the relay boundary's isSafeRecordingPath guard.
 */
export function buildDefaultRecordingPath(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const fileName = `Broadify-Meeting-${stamp}.mp4`;
  const baseDir =
    osPlatform() === "win32"
      ? join(homedir(), "Videos")
      : join(homedir(), "Movies");
  return join(baseDir, fileName);
}
