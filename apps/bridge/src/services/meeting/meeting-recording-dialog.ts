import { execFile } from "node:child_process";
import { platform as osPlatform } from "node:os";

/**
 * Shows the native macOS "save file" panel via osascript and returns the chosen
 * POSIX path (with a `.mp4` extension enforced), or null if the user cancelled
 * or the platform is unsupported. The recording file is written on this machine
 * by the meeting helper, so the location must be picked here on the bridge, not
 * in the browser.
 */
export async function pickRecordingSavePath(
  defaultName = "meeting.mp4",
): Promise<string | null> {
  if (osPlatform() !== "darwin") {
    return null;
  }
  const safeName = defaultName.replace(/["\\]/g, "");
  const script = [
    "activate",
    `set theFile to choose file name with prompt "Meeting-Aufnahme speichern" default name "${safeName}"`,
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
