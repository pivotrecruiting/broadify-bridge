import type { HelperStderrLogLevelT } from "./helper-process-session.js";

/**
 * Lines the decklink-helper prints periodically while playback runs. They are
 * telemetry, not problems, and would otherwise dominate the bridge log.
 */
const ROUTINE_TELEMETRY_PATTERN = /^(Playback stats:|Buffered video frame count:)/;

/**
 * Lines the helper itself marks as tolerated (e.g. a FrameBus whose size is
 * larger than required). They mention "mismatch" but are informational.
 */
const TOLERATED_PATTERN = /\(tolerated\)/i;

/**
 * Vocabulary the helper uses when something actually went wrong. Hard
 * failures are additionally reported as a structured `fatal` event on stdout
 * and logged at error level by the adapter lifecycle, so stderr stays at warn.
 */
const FAILURE_PATTERN =
  /error|failed|failure|cannot|could not|unable|invalid|not found|denied|not supported|mismatch|stale|aborted/i;

/**
 * Classify one stderr line of the native decklink-helper for the bridge log.
 *
 * The helper writes diagnostics, periodic telemetry and failures to stderr
 * alike. Previously every line was logged at error level, which made routine
 * output indistinguishable from real failures.
 *
 * @param line Trimmed, non-empty stderr line (without the adapter prefix).
 * @returns Log level the adapter should use for the line.
 */
export function classifyDeckLinkHelperStderrLine(line: string): HelperStderrLogLevelT {
  if (ROUTINE_TELEMETRY_PATTERN.test(line)) {
    return "debug";
  }
  if (TOLERATED_PATTERN.test(line)) {
    return "info";
  }
  if (FAILURE_PATTERN.test(line)) {
    return "warn";
  }
  return "info";
}
