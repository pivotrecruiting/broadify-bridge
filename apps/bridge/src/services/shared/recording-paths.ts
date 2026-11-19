import { mkdirSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";

/**
 * Single source of truth for default recording locations. Every headless or
 * non-macOS trigger (Stream Deck REC key, Windows fallback of the save panel,
 * PGM recording without an explicit path) lands in the same folder with the
 * same naming scheme, so operators find their files in one place.
 */
export const DEFAULT_RECORDINGS_SUBDIR = "Broadify";

export type RecordingKindT = "meeting" | "pgm";

const FILE_PREFIX_BY_KIND: Record<RecordingKindT, string> = {
  meeting: "Broadify-Meeting-",
  pgm: "Broadify-PGM-",
};

export type RecordingPathDepsT = {
  platform?: NodeJS.Platform;
  home?: string;
  /** Directory creation hook; defaults to a recursive sync mkdir. */
  mkdir?: (dir: string) => void;
};

/**
 * Platform default recordings folder: `~/Movies/Broadify` (macOS/Linux) or
 * `~/Videos/Broadify` (Windows).
 */
export function resolveDefaultRecordingsDir(
  platform: NodeJS.Platform = osPlatform(),
  home: string = homedir(),
): string {
  const videosFolder = platform === "win32" ? "Videos" : "Movies";
  return join(home, videosFolder, DEFAULT_RECORDINGS_SUBDIR);
}

/** Timestamp `YYYY-MM-DD_HH-mm-ss` in local time. */
export function formatRecordingTimestamp(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  );
}

function defaultMkdir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Builds `<dir>/Broadify-Meeting-<stamp>.mp4` or `<dir>/Broadify-PGM-<stamp>.mp4`
 * under the platform default recordings folder and creates that folder best
 * effort (the recorders do not create directories, so a missing folder would
 * otherwise fail opaquely at recording start). The result is an absolute
 * `.mp4` path without parent traversal, so it passes the relay boundary's
 * isSafeRecordingPath guard.
 */
export function buildDefaultRecordingPath(
  kind: RecordingKindT,
  now: Date = new Date(),
  deps: RecordingPathDepsT = {},
): string {
  const dir = resolveDefaultRecordingsDir(deps.platform, deps.home);
  const mkdir = deps.mkdir ?? defaultMkdir;
  try {
    mkdir(dir);
  } catch {
    // Best effort - the recorder reports the real error if writing fails.
  }
  return join(dir, `${FILE_PREFIX_BY_KIND[kind]}${formatRecordingTimestamp(now)}.mp4`);
}
