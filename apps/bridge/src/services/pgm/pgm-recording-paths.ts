import { mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

import { pickRecordingSavePath } from "../meeting/meeting-recording-dialog.js";

/** Timestamped default: ~/Movies/Broadify/Broadify-PGM-<date>_<time>.mp4 (Videos on Windows). */
export function buildDefaultProgramRecordingPath(now = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  const baseDir = join(homedir(), osPlatform() === "win32" ? "Videos" : "Movies", "Broadify");
  try {
    mkdirSync(baseDir, { recursive: true });
  } catch {
    // Best effort; the helper reports the real error if writing fails.
  }
  return join(baseDir, `Broadify-PGM-${stamp}.mp4`);
}

/** Native save panel (macOS), timestamped default elsewhere; shared with the meeting recording. */
export function pickProgramRecordingPath(defaultName: string, locale: string): Promise<string | null> {
  return pickRecordingSavePath(defaultName, locale);
}
