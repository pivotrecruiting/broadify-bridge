import { mkdir, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** Rotated files kept per log name; older ones are deleted (WP-2.7). */
const MAX_ROTATED_LOGS = 5;

/**
 * Delete rotated log files beyond the retention limit. Rotated files are
 * named `<base>-<timestamp>.log`, so a lexicographic sort orders them by age.
 */
export async function pruneRotatedLogs(
  logDir: string,
  base = "bridge"
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(logDir);
  } catch {
    return;
  }
  const rotated = entries
    .filter((name) => name.startsWith(`${base}-`) && name.endsWith(".log"))
    .sort();
  const excess = rotated.slice(0, Math.max(0, rotated.length - MAX_ROTATED_LOGS));
  for (const name of excess) {
    try {
      await unlink(path.join(logDir, name));
    } catch {
      // Best effort: a locked/vanished file must not block startup.
    }
  }
}

/**
 * Ensure a bridge log file exists, rotate if it exceeds the size limit, and
 * prune old rotated files.
 *
 * Rotation happens at startup only: pino keeps the file descriptor open for
 * the process lifetime, and on POSIX a rename mid-run would silently redirect
 * writes into the rotated file. The size cap therefore bounds a single run;
 * retention pruning bounds the total footprint across runs.
 *
 * @param userDataDir Bridge user data directory.
 * @returns Absolute path to the active log file.
 */
export async function ensureBridgeLogFile(
  userDataDir: string
): Promise<string> {
  const logDir = path.join(userDataDir, "logs");
  await mkdir(logDir, { recursive: true });

  const logPath = path.join(logDir, "bridge.log");

  try {
    const info = await stat(logPath);
    if (info.size > MAX_LOG_BYTES) {
      const rotated = path.join(logDir, `bridge-${Date.now()}.log`);
      await rename(logPath, rotated);
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if ((error as { code?: string }).code === "ENOENT") {
        await pruneRotatedLogs(logDir);
        return logPath;
      }
    }
    throw error;
  }

  await pruneRotatedLogs(logDir);
  return logPath;
}