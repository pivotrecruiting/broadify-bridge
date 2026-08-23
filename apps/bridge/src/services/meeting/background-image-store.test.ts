import { dirname, join } from "node:path";
import {
  backgroundCacheKey,
  BACKGROUND_IMAGE_INDEX_FILE,
  fetchBackgroundImage,
  storeBackgroundImage,
  type BackgroundImageStoreDepsT,
  type BackgroundIndexT,
} from "./background-image-store.js";
import {
  GuardedDownloadHttpError,
  GuardedDownloadPolicyError,
  isTransientDownloadError,
  type GuardedConditionalDownloadT,
} from "./media-download.js";

type FakeStoreT = {
  deps: BackgroundImageStoreDepsT;
  files: Map<string, Buffer | string>;
  download: jest.Mock<Promise<GuardedConditionalDownloadT>, [string, unknown]>;
  warn: jest.Mock;
  unlinked: string[];
  writes: string[];
  readIndex: () => BackgroundIndexT;
  clock: { now: number };
};

const DIRECTORY = "/data/meeting-backgrounds";
const URL_A = "https://cdn.example.com/bucket/bg-a.png?token=sig1";
const URL_A_RESIGNED = "https://cdn.example.com/bucket/bg-a.png?token=sig2";

function ok(body: string, extra: Partial<Extract<GuardedConditionalDownloadT, { status: "ok" }>> = {}): GuardedConditionalDownloadT {
  return {
    status: "ok",
    body: Buffer.from(body),
    contentType: "image/png",
    etag: '"etag-1"',
    lastModified: null,
    ...extra,
  };
}

function makeStore(overrides: Partial<BackgroundImageStoreDepsT> = {}): FakeStoreT {
  const files = new Map<string, Buffer | string>();
  const unlinked: string[] = [];
  const writes: string[] = [];
  const clock = { now: 1_000 };
  const download = jest.fn<Promise<GuardedConditionalDownloadT>, [string, unknown]>();
  const warn = jest.fn();
  const deps: BackgroundImageStoreDepsT = {
    directory: DIRECTORY,
    now: () => clock.now,
    fileExists: (path) => files.has(path),
    mkdir: async () => undefined,
    readFile: async (path) => {
      const value = files.get(path);
      if (value === undefined) {
        throw new Error("ENOENT");
      }
      return value.toString();
    },
    writeFile: async (path, body) => {
      writes.push(path);
      files.set(path, body);
    },
    unlink: async (path) => {
      unlinked.push(path);
      files.delete(path);
    },
    download,
    warn,
    ...overrides,
  };
  return {
    deps,
    files,
    download,
    warn,
    unlinked,
    writes,
    clock,
    readIndex: () =>
      JSON.parse(String(files.get(join(DIRECTORY, BACKGROUND_IMAGE_INDEX_FILE)) ?? "{}")),
  };
}

describe("background-image-store", () => {
  it("derives the cache key from origin + path, ignoring the query signature", () => {
    expect(backgroundCacheKey(URL_A)).toBe(backgroundCacheKey(URL_A_RESIGNED));
    expect(backgroundCacheKey(URL_A)).not.toBe(
      backgroundCacheKey("https://cdn.example.com/bucket/bg-b.png"),
    );
  });

  it("miss: downloads without conditional headers, stores and indexes the file", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));

    const result = await fetchBackgroundImage(URL_A, store.deps);

    expect(store.download).toHaveBeenCalledWith(URL_A, null);
    expect(result.cached).toBe(false);
    // join() normalizes separators, so this holds on Windows runners too.
    expect(dirname(result.path)).toBe(join(DIRECTORY));
    expect(result.path.endsWith(".png")).toBe(true);
    const entry = store.readIndex()[backgroundCacheKey(URL_A)];
    expect(entry).toMatchObject({
      file_path: result.path,
      etag: '"etag-1"',
      size: "png-bytes".length,
      last_used_at: 1_000,
    });
  });

  it("hit: sends the stored ETag and returns the cached path on 304 (re-signed URL)", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.clock.now = 2_000;
    store.download.mockResolvedValueOnce({ status: "not_modified" });

    const second = await fetchBackgroundImage(URL_A_RESIGNED, store.deps);

    expect(store.download).toHaveBeenLastCalledWith(URL_A_RESIGNED, {
      etag: '"etag-1"',
      lastModified: null,
    });
    expect(second).toEqual({ path: first.path, cached: true });
    expect(store.readIndex()[backgroundCacheKey(URL_A)].last_used_at).toBe(2_000);
    // Only the index was rewritten, not the image.
    expect(store.writes.filter((path) => path.endsWith(".png"))).toHaveLength(1);
  });

  it("re-downloads when the index entry exists but the file is gone", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.files.delete(first.path);
    store.download.mockResolvedValueOnce(ok("png-bytes"));

    const second = await fetchBackgroundImage(URL_A, store.deps);

    expect(store.download).toHaveBeenLastCalledWith(URL_A, null);
    expect(second.cached).toBe(false);
    expect(store.files.has(first.path)).toBe(true);
  });

  it("200 with changed content stores a new file and updates the validators", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("version-1"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.download.mockResolvedValueOnce(ok("version-2", { etag: '"etag-2"' }));

    const second = await fetchBackgroundImage(URL_A, store.deps);

    expect(second.cached).toBe(false);
    expect(second.path).not.toBe(first.path);
    expect(store.readIndex()[backgroundCacheKey(URL_A)]).toMatchObject({
      file_path: second.path,
      etag: '"etag-2"',
    });
  });

  it("falls back to the cached file with a warning when revalidation fails", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.download.mockRejectedValueOnce(new Error("Download timed out."));

    const second = await fetchBackgroundImage(URL_A, store.deps);

    expect(second).toEqual({ path: first.path, cached: true });
    expect(store.warn).toHaveBeenCalledWith(
      expect.stringContaining("Download timed out."),
    );
  });

  it("falls back to the cached file on a node network error (ETIMEDOUT)", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    const networkError = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    store.download.mockRejectedValueOnce(networkError);

    await expect(fetchBackgroundImage(URL_A, store.deps)).resolves.toEqual({
      path: first.path,
      cached: true,
    });
    expect(store.warn).toHaveBeenCalledTimes(1);
  });

  it("does not serve the cached file when revalidation is refused (403)", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.download.mockRejectedValueOnce(new GuardedDownloadHttpError(403));

    await expect(fetchBackgroundImage(URL_A, store.deps)).rejects.toThrow(
      "Download failed with HTTP 403.",
    );
    expect(store.warn).not.toHaveBeenCalled();
    expect(store.readIndex()[backgroundCacheKey(URL_A)].file_path).toBe(first.path);
    expect(store.files.has(first.path)).toBe(true);
  });

  it("drops the entry and file when the object is gone upstream (404)", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.download.mockRejectedValueOnce(new GuardedDownloadHttpError(404));

    await expect(fetchBackgroundImage(URL_A, store.deps)).rejects.toThrow("HTTP 404");
    expect(store.readIndex()[backgroundCacheKey(URL_A)]).toBeUndefined();
    expect(store.unlinked).toEqual([first.path]);
    expect(store.files.has(first.path)).toBe(false);
  });

  it("rethrows guard/policy rejections instead of using the cache", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("png-bytes"));
    const first = await fetchBackgroundImage(URL_A, store.deps);
    store.download.mockRejectedValueOnce(
      new GuardedDownloadPolicyError("Download host resolves to a non-public address."),
    );

    await expect(fetchBackgroundImage(URL_A, store.deps)).rejects.toThrow(
      "non-public address",
    );
    expect(store.warn).not.toHaveBeenCalled();
    expect(store.files.has(first.path)).toBe(true);
  });

  it("isTransientDownloadError only accepts transport-level failures", () => {
    expect(isTransientDownloadError(new GuardedDownloadHttpError(401))).toBe(false);
    expect(isTransientDownloadError(new GuardedDownloadPolicyError("x"))).toBe(false);
    expect(isTransientDownloadError(new Error("Download timed out."))).toBe(true);
    expect(
      isTransientDownloadError(Object.assign(new Error("reset"), { code: "ECONNRESET" })),
    ).toBe(true);
    expect(isTransientDownloadError(new Error("generic"))).toBe(false);
    expect(isTransientDownloadError("string")).toBe(false);
  });

  it("propagates download errors when nothing is cached", async () => {
    const store = makeStore();
    store.download.mockRejectedValueOnce(new Error("Download failed with HTTP 403."));

    await expect(fetchBackgroundImage(URL_A, store.deps)).rejects.toThrow("HTTP 403");
    expect(store.warn).not.toHaveBeenCalled();
  });

  it("skips the file write when the same content is already stored", async () => {
    const store = makeStore();
    store.download.mockResolvedValueOnce(ok("same-bytes"));
    await fetchBackgroundImage("https://cdn.example.com/a.png", store.deps);
    store.download.mockResolvedValueOnce(ok("same-bytes"));
    await fetchBackgroundImage("https://cdn.example.com/b.png", store.deps);

    expect(store.writes.filter((path) => path.endsWith(".png"))).toHaveLength(1);
    expect(Object.keys(store.readIndex())).toHaveLength(2);
  });

  it("evicts least-recently-used entries beyond the file cap, never the one just stored", async () => {
    const store = makeStore({ maxFiles: 2 });
    const urls = ["a", "b", "c"].map((name) => `https://cdn.example.com/${name}.png`);
    const paths: string[] = [];
    for (const [i, url] of urls.entries()) {
      store.clock.now = 1_000 + i;
      store.download.mockResolvedValueOnce(ok(`bytes-${url}`));
      paths.push((await fetchBackgroundImage(url, store.deps)).path);
    }

    expect(store.unlinked).toEqual([paths[0]]);
    expect(store.files.has(paths[0])).toBe(false);
    expect(store.files.has(paths[1])).toBe(true);
    expect(store.files.has(paths[2])).toBe(true);
    expect(Object.keys(store.readIndex())).toEqual([
      backgroundCacheKey(urls[1]),
      backgroundCacheKey(urls[2]),
    ]);
  });

  it("evicts by total bytes and keeps files still referenced by another entry", async () => {
    const store = makeStore({ maxFiles: 10, maxTotalBytes: 20 });
    store.clock.now = 1;
    store.download.mockResolvedValueOnce(ok("0123456789")); // 10 bytes
    const a = await fetchBackgroundImage("https://cdn.example.com/a.png", store.deps);
    store.clock.now = 2;
    store.download.mockResolvedValueOnce(ok("0123456789")); // same content, 10 bytes
    await fetchBackgroundImage("https://cdn.example.com/b.png", store.deps);
    store.clock.now = 3;
    store.download.mockResolvedValueOnce(ok("abcdefghij")); // 10 bytes -> 30 > 20
    await fetchBackgroundImage("https://cdn.example.com/c.png", store.deps);

    // Entry a was evicted but its file is still referenced by b.
    expect(store.unlinked).toEqual([]);
    expect(store.files.has(a.path)).toBe(true);
    expect(Object.keys(store.readIndex())).toHaveLength(2);
  });

  it("storeBackgroundImage indexes uploads under their content hash", async () => {
    const store = makeStore();
    const path = await storeBackgroundImage(Buffer.from("upload"), "image/jpeg", store.deps);

    expect(path.endsWith(".jpg")).toBe(true);
    expect(Object.keys(store.readIndex())[0].startsWith("upload:")).toBe(true);
    await expect(
      storeBackgroundImage(Buffer.from("x"), "text/plain", store.deps),
    ).rejects.toThrow("Only PNG, JPEG or WebP");
  });
});
