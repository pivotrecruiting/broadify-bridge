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

/**
 * File extensions a recording is written with; each is the name of its
 * container. Which one a meeting recording gets follows from its codec
 * (services/meeting/meeting-recording-codecs.ts); a PGM recording is `.mp4`.
 */
export const RECORDING_FILE_EXTENSIONS = ["mp4", "mov"] as const;
export type RecordingFileExtensionT = (typeof RECORDING_FILE_EXTENSIONS)[number];
export const DEFAULT_RECORDING_FILE_EXTENSION: RecordingFileExtensionT = "mp4";

const RECORDING_FILE_EXTENSION_PATTERN = new RegExp(
  `\\.(${RECORDING_FILE_EXTENSIONS.join("|")})$`,
  "i",
);

/** Whether the path ends with the extension (case-insensitive). */
export function hasRecordingExtension(
  filePath: string,
  extension: RecordingFileExtensionT,
): boolean {
  return filePath.toLowerCase().endsWith(`.${extension}`);
}

/**
 * The path with the given recording extension: unchanged when it already has
 * it, otherwise with another recording extension replaced or none appended
 * to (`take.mp4` -> `take.mov`, `take` -> `take.mov`).
 */
export function withRecordingExtension(
  filePath: string,
  extension: RecordingFileExtensionT,
): string {
  if (hasRecordingExtension(filePath, extension)) {
    return filePath;
  }
  return `${filePath.replace(RECORDING_FILE_EXTENSION_PATTERN, "")}.${extension}`;
}

const FILE_PREFIX_BY_KIND: Record<RecordingKindT, string> = {
  meeting: "Broadify-Meeting-",
  pgm: "Broadify-PGM-",
};

export type RecordingPathOptionsT = {
  /** Extension of the file (default `.mp4`). */
  extension?: RecordingFileExtensionT;
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
 * Builds `<dir>/Broadify-Meeting-<stamp>.<ext>` or `<dir>/Broadify-PGM-<stamp>.<ext>`
 * under the platform default recordings folder and creates that folder best
 * effort (the recorders do not create directories, so a missing folder would
 * otherwise fail opaquely at recording start). The result is an absolute
 * path with the requested recording extension and without parent traversal,
 * so it passes the relay boundary's isSafeRecordingPath guard.
 */
export function buildDefaultRecordingPath(
  kind: RecordingKindT,
  now: Date = new Date(),
  options: RecordingPathOptionsT = {},
): string {
  const dir = resolveDefaultRecordingsDir(options.platform, options.home);
  const mkdir = options.mkdir ?? defaultMkdir;
  const extension = options.extension ?? DEFAULT_RECORDING_FILE_EXTENSION;
  try {
    mkdir(dir);
  } catch {
    // Best effort - the recorder reports the real error if writing fails.
  }
  return join(
    dir,
    `${FILE_PREFIX_BY_KIND[kind]}${formatRecordingTimestamp(now)}.${extension}`,
  );
}
