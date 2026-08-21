import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getBridgeContext } from "../bridge-context.js";
import {
  downloadGuardedBufferConditional,
  type ConditionalRequestT,
  type GuardedConditionalDownloadT,
} from "./media-download.js";

/** Company background uploads accepted by the native compositor. */
export const BACKGROUND_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Directory name under userDataDir holding the cached background files. */
export const BACKGROUND_IMAGE_DIR_NAME = "meeting-backgrounds";

/** Index file (next to the images) mapping cache keys to stored files. */
export const BACKGROUND_IMAGE_INDEX_FILE = "index.json";

/** LRU cap: at most this many indexed background files are kept. */
export const BACKGROUND_CACHE_MAX_FILES = 20;

/** LRU cap: at most this many bytes of indexed background files are kept. */
export const BACKGROUND_CACHE_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

/** Timeout for the conditional revalidation / download of a background. */
export const BACKGROUND_FETCH_TIMEOUT_MS = 25_000;

const BackgroundIndexEntrySchema = z.object({
  file_path: z.string().min(1),
  etag: z.string().nullable().optional(),
  last_modified: z.string().nullable().optional(),
  size: z.number().int().nonnegative(),
  last_used_at: z.number().int().nonnegative(),
});

const BackgroundIndexSchema = z.record(z.string(), BackgroundIndexEntrySchema);

export type BackgroundIndexEntryT = z.infer<typeof BackgroundIndexEntrySchema>;
export type BackgroundIndexT = z.infer<typeof BackgroundIndexSchema>;

/** Injectable dependencies so the cache logic is unit-testable. */
export type BackgroundImageStoreDepsT = {
  directory: string;
  now: () => number;
  fileExists: (path: string) => boolean;
  mkdir: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, body: Buffer | string) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  download: (
    url: string,
    conditional: ConditionalRequestT | null,
  ) => Promise<GuardedConditionalDownloadT>;
  warn: (message: string) => void;
  maxFiles?: number;
  maxTotalBytes?: number;
};

export type BackgroundFetchResultT = {
  path: string;
  /** True when the cached file was reused (304 or offline fallback). */
  cached: boolean;
};

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
 * Cache key for a download URL: origin + path without query/fragment, so a
 * re-signed Supabase URL (token in the query) maps onto the same entry.
 */
export function backgroundCacheKey(rawUrl: string): string {
  const url = new URL(rawUrl);
  return createHash("sha256")
    .update(`${url.origin}${url.pathname}`)
    .digest("hex")
    .slice(0, 32);
}

function defaultDeps(): BackgroundImageStoreDepsT {
  const context = getBridgeContext();
  return {
    directory: join(context.userDataDir, BACKGROUND_IMAGE_DIR_NAME),
    now: () => Date.now(),
    fileExists: (path) => existsSync(path),
    mkdir: async (path) => {
      await mkdir(path, { recursive: true });
    },
    readFile: (path) => readFile(path, "utf8"),
    writeFile: (path, body) => writeFile(path, body),
    unlink: (path) => unlink(path),
    download: (url, conditional) =>
      downloadGuardedBufferConditional(
        url,
        BACKGROUND_IMAGE_MAX_BYTES,
        BACKGROUND_FETCH_TIMEOUT_MS,
        conditional ?? {},
      ),
    warn: (message) => context.logger.warn(message),
  };
}

async function readIndex(deps: BackgroundImageStoreDepsT): Promise<BackgroundIndexT> {
  const indexPath = join(deps.directory, BACKGROUND_IMAGE_INDEX_FILE);
  if (!deps.fileExists(indexPath)) {
    return {};
  }
  try {
    const parsed = BackgroundIndexSchema.safeParse(
      JSON.parse(await deps.readFile(indexPath)),
    );
    return parsed.success ? parsed.data : {};
  } catch {
    // A corrupt index only costs a re-download; never fail the command.
    return {};
  }
}

async function writeIndex(
  deps: BackgroundImageStoreDepsT,
  index: BackgroundIndexT,
): Promise<void> {
  await deps.writeFile(
    join(deps.directory, BACKGROUND_IMAGE_INDEX_FILE),
    JSON.stringify(index),
  );
}

/**
 * Evicts least-recently-used entries beyond the file/byte caps. The entry
 * under `keepKey` (just stored) is never evicted. Files still referenced by
 * another entry (same content, different URL) are kept on disk.
 */
function evictLeastRecentlyUsed(
  index: BackgroundIndexT,
  keepKey: string,
  deps: BackgroundImageStoreDepsT,
): string[] {
  const maxFiles = deps.maxFiles ?? BACKGROUND_CACHE_MAX_FILES;
  const maxTotalBytes = deps.maxTotalBytes ?? BACKGROUND_CACHE_MAX_TOTAL_BYTES;
  const ordered = Object.entries(index)
    .filter(([key]) => key !== keepKey)
    .sort((a, b) => a[1].last_used_at - b[1].last_used_at);
  let count = Object.keys(index).length;
  let total = Object.values(index).reduce((sum, entry) => sum + entry.size, 0);
  const removedPaths: string[] = [];
  for (const [key, entry] of ordered) {
    if (count <= maxFiles && total <= maxTotalBytes) {
      break;
    }
    delete index[key];
    count -= 1;
    total -= entry.size;
    const stillReferenced = Object.values(index).some(
      (other) => other.file_path === entry.file_path,
    );
    if (!stillReferenced) {
      removedPaths.push(entry.file_path);
    }
  }
  return removedPaths;
}

function validateBody(body: Buffer, contentType: string): string {
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
  return extension;
}

/**
 * Writes the body under its content hash (skipped when the file already
 * exists), registers it in the index under `key` and evicts LRU entries.
 */
async function storeAndIndex(
  key: string,
  body: Buffer,
  contentType: string,
  validators: ConditionalRequestT,
  deps: BackgroundImageStoreDepsT,
): Promise<string> {
  const extension = validateBody(body, contentType);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  await deps.mkdir(deps.directory);
  const filePath = join(deps.directory, `${hash}.${extension}`);
  if (!deps.fileExists(filePath)) {
    await deps.writeFile(filePath, body);
  }
  const index = await readIndex(deps);
  index[key] = {
    file_path: filePath,
    etag: validators.etag ?? null,
    last_modified: validators.lastModified ?? null,
    size: body.length,
    last_used_at: deps.now(),
  };
  const removed = evictLeastRecentlyUsed(index, key, deps);
  await writeIndex(deps, index);
  for (const path of removed) {
    if (path === filePath) {
      continue;
    }
    await deps.unlink(path).catch(() => undefined);
  }
  return filePath;
}

/**
 * Stores a company background image under a content hash and returns the
 * absolute path the native compositor loads (keyer.configure
 * background_image_path). Used by the local HTTP upload route; uploads are
 * indexed under their content hash so the LRU cleanup covers them too.
 */
export async function storeBackgroundImage(
  body: Buffer,
  contentType: string,
  deps: BackgroundImageStoreDepsT = defaultDeps(),
): Promise<string> {
  validateBody(body, contentType);
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  return storeAndIndex(`upload:${hash}`, body, contentType, {}, deps);
}

/**
 * Fetches a cloud-hosted background through the guarded downloader with a
 * persistent cache:
 *  - index hit + file present: conditional GET; 304 returns the cached path,
 *    200 stores the new content and updates the validators;
 *  - conditional request failure with a cached file: cached path + warn;
 *  - miss: plain download, store, index.
 */
export async function fetchBackgroundImage(
  url: string,
  deps: BackgroundImageStoreDepsT = defaultDeps(),
): Promise<BackgroundFetchResultT> {
  const key = backgroundCacheKey(url);
  const index = await readIndex(deps);
  const entry = index[key];
  const cachedPath =
    entry && deps.fileExists(entry.file_path) ? entry.file_path : null;

  let result: GuardedConditionalDownloadT;
  try {
    result = await deps.download(
      url,
      cachedPath
        ? { etag: entry?.etag ?? null, lastModified: entry?.last_modified ?? null }
        : null,
    );
  } catch (error: unknown) {
    if (!cachedPath) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    deps.warn(
      `[Meeting] Background revalidation failed, using cached file: ${message}`,
    );
    await touchEntry(key, deps);
    return { path: cachedPath, cached: true };
  }

  if (result.status === "not_modified") {
    if (!cachedPath) {
      throw new Error("Download failed with HTTP 304.");
    }
    await touchEntry(key, deps);
    return { path: cachedPath, cached: true };
  }

  const path = await storeAndIndex(
    key,
    result.body,
    result.contentType,
    { etag: result.etag, lastModified: result.lastModified },
    deps,
  );
  return { path, cached: false };
}

async function touchEntry(
  key: string,
  deps: BackgroundImageStoreDepsT,
): Promise<void> {
  const index = await readIndex(deps);
  const entry = index[key];
  if (!entry) {
    return;
  }
  entry.last_used_at = deps.now();
  await writeIndex(deps, index).catch(() => undefined);
}
