import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getBridgeContext } from "../bridge-context.js";

/** Company background uploads accepted by the native compositor. */
export const BACKGROUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Maps an image content type onto the stored file extension.
 * Returns null for unsupported types.
 */
export function backgroundImageExtension(contentType: string): string | null {
  if (contentType.includes("png")) {
    return "png";
  }
  if (contentType.includes("webp")) {
    return "webp";
  }
  if (contentType.includes("jpeg") || contentType.includes("jpg")) {
    return "jpg";
  }
  return null;
}

/**
 * Stores a company background image under a content hash and returns the
 * absolute path the native compositor loads (keyer.configure
 * background_image_path). Shared by the local HTTP route and the relay
 * fetch command.
 */
export async function storeBackgroundImage(
  body: Buffer,
  contentType: string,
): Promise<string> {
  if (body.length === 0) {
    throw new Error("Empty image body.");
  }
  if (body.length > BACKGROUND_IMAGE_MAX_BYTES) {
    throw new Error("Background image exceeds the allowed size.");
  }
  const extension = backgroundImageExtension(contentType);
  if (!extension) {
    throw new Error("Only PNG, JPEG or WebP backgrounds are supported.");
  }
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  const directory = join(getBridgeContext().userDataDir, "meeting-backgrounds");
  await mkdir(directory, { recursive: true });
  const filePath = join(directory, `${hash}.${extension}`);
  await writeFile(filePath, body);
  return filePath;
}
