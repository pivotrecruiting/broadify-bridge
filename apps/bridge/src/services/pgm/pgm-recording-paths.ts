import { pickRecordingSavePath } from "../meeting/meeting-recording-dialog.js";
import { buildDefaultRecordingPath } from "../shared/recording-paths.js";

/** Timestamped default: ~/Movies/Broadify/Broadify-PGM-<date>_<time>.mp4 (Videos on Windows); shared folder with the meeting recording. */
export function buildDefaultProgramRecordingPath(now = new Date()): string {
  return buildDefaultRecordingPath("pgm", now);
}

/** Native save panel (macOS), timestamped default elsewhere; shared with the meeting recording. */
export function pickProgramRecordingPath(defaultName: string, locale: string): Promise<string | null> {
  return pickRecordingSavePath(defaultName, locale);
}
