import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Ensure a directory exists.
 *
 * @param dirPath Directory path to create.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Write JSON to disk atomically.
 *
 * @param filePath Destination path.
 * @param data JSON-serializable payload.
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown
): Promise<void> {
  const dir = path.dirname(filePath);
  await ensureDir(dir);

  const tempPath = `${filePath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tempPath, json, "utf-8");
  await fs.rename(tempPath, filePath);
}
