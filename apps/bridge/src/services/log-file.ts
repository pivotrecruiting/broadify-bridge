import { mkdir, stat, rename } from "node:fs/promises";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

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
        return logPath;
      }
    }
    throw error;
  }

  return logPath;
}
