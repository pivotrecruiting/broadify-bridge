import { promises as fs } from "node:fs";
import path from "node:path";

const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_SUFFIX = ".jsonl";
const MARKER_SUFFIX = ".uploaded.json";

/** Sessions that never reached the platform are kept this long. */
export const SESSION_LOG_MAX_AGE_MS = 30 * DAY_MS;
/** Uploaded sessions (marker present) are kept this long after the upload. */
export const SESSION_LOG_UPLOADED_MAX_AGE_MS = 7 * DAY_MS;
/** Upper bound of session files on disk, oldest first out. */
export const SESSION_LOG_MAX_FILES = 200;

export type SessionLogRetentionOptionsT = {
  now?: () => number;
  /** Session currently being written; never pruned. */
  isSessionOpen?: (sessionId: string) => boolean;
  maxAgeMs?: number;
  uploadedMaxAgeMs?: number;
  maxFiles?: number;
};

type SessionFileT = {
  sessionId: string;
  /** mtime of the session file; null for a marker whose session file is gone. */
  logMtimeMs: number | null;
  /** mtime of the `.uploaded.json` marker; null while not uploaded. */
  markerMtimeMs: number | null;
};

const mtimeOf = async (file: string): Promise<number | null> => {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Delete session logs beyond the retention limits: un-uploaded sessions after
 * 30 days, uploaded ones 7 days after their marker was written, and the
 * oldest sessions beyond 200 files. The open session is never touched. Best
 * effort like `pruneRotatedLogs`: a missing directory or a locked/vanished
 * file never throws.
 *
 * @returns Number of pruned sessions.
 */
export async function pruneSessionLogs(dir: string, options: SessionLogRetentionOptionsT = {}): Promise<number> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return 0;
  }
  const now = (options.now ?? Date.now)();
  const maxAgeMs = options.maxAgeMs ?? SESSION_LOG_MAX_AGE_MS;
  const uploadedMaxAgeMs = options.uploadedMaxAgeMs ?? SESSION_LOG_UPLOADED_MAX_AGE_MS;
  const maxFiles = options.maxFiles ?? SESSION_LOG_MAX_FILES;

  const ids = new Set<string>();
  for (const name of entries) {
    if (name.endsWith(MARKER_SUFFIX)) {
      ids.add(name.slice(0, -MARKER_SUFFIX.length));
    } else if (name.endsWith(LOG_SUFFIX)) {
      ids.add(name.slice(0, -LOG_SUFFIX.length));
    }
  }

  const sessions: SessionFileT[] = [];
  for (const sessionId of ids) {
    if (options.isSessionOpen?.(sessionId)) {
      continue;
    }
    const logMtimeMs = entries.includes(`${sessionId}${LOG_SUFFIX}`) ? await mtimeOf(path.join(dir, `${sessionId}${LOG_SUFFIX}`)) : null;
    const markerMtimeMs = entries.includes(`${sessionId}${MARKER_SUFFIX}`)
      ? await mtimeOf(path.join(dir, `${sessionId}${MARKER_SUFFIX}`))
      : null;
    if (logMtimeMs === null && markerMtimeMs === null) {
      continue;
    }
    sessions.push({ sessionId, logMtimeMs, markerMtimeMs });
  }

  const expired = (session: SessionFileT): boolean =>
    session.markerMtimeMs !== null
      ? now - session.markerMtimeMs > uploadedMaxAgeMs
      : now - (session.logMtimeMs ?? 0) > maxAgeMs;

  const doomed = new Set<SessionFileT>(sessions.filter(expired));
  const kept = sessions
    .filter((session) => !doomed.has(session) && session.logMtimeMs !== null)
    .sort((a, b) => (a.logMtimeMs ?? 0) - (b.logMtimeMs ?? 0));
  for (const session of kept.slice(0, Math.max(0, kept.length - maxFiles))) {
    doomed.add(session);
  }

  for (const session of doomed) {
    // Log first: a marker left behind by a crash in between is harmless and goes on the next run.
    for (const suffix of [LOG_SUFFIX, MARKER_SUFFIX]) {
      try {
        await fs.unlink(path.join(dir, `${session.sessionId}${suffix}`));
      } catch {
        // Best effort: a locked/vanished file must not block the bridge.
      }
    }
  }
  return doomed.size;
}
