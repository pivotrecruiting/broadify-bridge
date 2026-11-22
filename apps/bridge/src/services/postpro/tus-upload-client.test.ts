import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { RecordingUploadGrantT, RecordingUploadPlatformT } from "./recording-upload-platform.js";
import type { RecordingUploadRecordT, RecordingUploadSettingsT } from "./recording-upload-store.js";
import { RecordingUploader } from "./recording-uploader.js";
import {
  TUS_SIGNED_ENDPOINT_PATH,
  TusHttpError,
  TusUploadClient,
  isTusOffsetConflict,
  isTusTokenRefusal,
  isTusUploadGone,
  parseTusEndpoint,
  readRecordingUploadMaxKbps,
  GUARDED_TUS_TRANSPORT,
  type TusTransportT,
} from "./tus-upload-client.js";

const sha256 = (data: Buffer): string => createHash("sha256").update(data).digest("hex");

/** Plain-http transport for the local fake server (the production transport is https + URL guard). */
const LOCAL_TRANSPORT: TusTransportT = {
  parseUrl: (rawUrl) => new URL(rawUrl),
  request: (url, options, onResponse) => httpRequest(url, options, onResponse),
};

type FakeUploadT = { length: number; data: Buffer; metadata: Record<string, string> };

/**
 * The subset of the storage server's tus endpoint the client speaks:
 * POST creates an upload (signed token in `x-signature`), HEAD reports the
 * offset, PATCH appends. Faults are injected per test.
 */
class FakeTusServer {
  readonly uploads = new Map<string, FakeUploadT>();
  readonly validTokens = new Set<string>(["token-1"]);
  readonly requests: Array<{ method: string; headers: IncomingMessage["headers"] }> = [];
  /** Destroy the connection of the next PATCH after this many body bytes (kept, as a tus server does). */
  dropNextPatchAfterBytes: number | null = null;
  locationOverride: string | null = null;
  private server: Server | null = null;
  origin = "";

  get endpoint(): string {
    return `${this.origin}${TUS_SIGNED_ENDPOINT_PATH}`;
  }

  count(method: string): number {
    return this.requests.filter((request) => request.method === method).length;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    this.origin = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const method = request.method ?? "";
    this.requests.push({ method, headers: request.headers });
    const reply = (status: number, headers: Record<string, string> = {}, body = "") => {
      response.writeHead(status, { "tus-resumable": "1.0.0", ...headers });
      response.end(body);
    };
    if (!this.validTokens.has(String(request.headers["x-signature"]))) {
      request.resume();
      reply(403, {}, JSON.stringify({ message: "signature verification failed" }));
      return;
    }
    const url = new URL(request.url ?? "/", this.origin);
    if (method === "POST" && url.pathname === TUS_SIGNED_ENDPOINT_PATH) {
      const id = randomUUID();
      const metadata = Object.fromEntries(
        String(request.headers["upload-metadata"])
          .split(",")
          .map((entry) => entry.split(" "))
          .map(([key, value]) => [key, Buffer.from(value, "base64").toString("utf8")]),
      );
      this.uploads.set(id, { length: Number(request.headers["upload-length"]), data: Buffer.alloc(0), metadata });
      reply(201, { location: this.locationOverride ?? `${TUS_SIGNED_ENDPOINT_PATH}/${id}` });
      return;
    }
    const upload = this.uploads.get(url.pathname.slice(TUS_SIGNED_ENDPOINT_PATH.length + 1));
    if (!upload) {
      request.resume();
      reply(404);
      return;
    }
    if (method === "HEAD") {
      reply(200, { "upload-offset": String(upload.data.length), "upload-length": String(upload.length) });
      return;
    }
    if (method !== "PATCH") {
      reply(405);
      return;
    }
    if (Number(request.headers["upload-offset"]) !== upload.data.length) {
      request.resume();
      reply(409);
      return;
    }
    const dropAfter = this.dropNextPatchAfterBytes;
    this.dropNextPatchAfterBytes = null;
    let received = 0;
    request.on("data", (chunk: Buffer) => {
      if (dropAfter !== null && received + chunk.length >= dropAfter) {
        upload.data = Buffer.concat([upload.data, chunk.subarray(0, dropAfter - received)]);
        received = dropAfter;
        request.destroy();
        return;
      }
      received += chunk.length;
      upload.data = Buffer.concat([upload.data, chunk]);
    });
    request.on("end", () => reply(204, { "upload-offset": String(upload.data.length) }));
    request.on("error", () => undefined);
  }
}

describe("TusUploadClient", () => {
  const server = new FakeTusServer();
  let dir: string;
  let filePath: string;
  let content: Buffer;

  const createOptions = () => ({
    endpoint: server.endpoint,
    token: "token-1",
    sizeBytes: content.length,
    bucket: "postpro-media",
    objectName: "orgs/o/recordings/r/source.mp4",
    contentType: "video/mp4",
  });

  const uploadAll = async (client: TusUploadClient, uploadUrl: string, token: string, from: number, chunk: number) => {
    let offset = from;
    while (offset < content.length) {
      offset = await client.patchChunk({
        uploadUrl,
        token,
        filePath,
        offset,
        length: Math.min(chunk, content.length - offset),
      });
    }
    return offset;
  };

  const onlyUpload = (): FakeUploadT => [...server.uploads.values()][0];

  beforeAll(async () => {
    await server.start();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-tus-"));
    filePath = path.join(dir, "Broadify-Meeting-test.mp4");
    content = randomBytes(300 * 1024 + 17);
    await fs.writeFile(filePath, content);
  });

  afterAll(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.uploads.clear();
    server.requests.length = 0;
    server.validTokens.clear();
    server.validTokens.add("token-1");
    server.dropNextPatchAfterBytes = null;
    server.locationOverride = null;
  });

  it("creates the upload with the signed token and the object metadata", async () => {
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const uploadUrl = await client.create(createOptions());

    expect(uploadUrl.startsWith(`${server.endpoint}/`)).toBe(true);
    const { headers } = server.requests[0];
    expect(headers["tus-resumable"]).toBe("1.0.0");
    expect(headers["x-signature"]).toBe("token-1");
    expect(headers["upload-length"]).toBe(String(content.length));
    expect(onlyUpload().metadata).toEqual({
      bucketName: "postpro-media",
      objectName: "orgs/o/recordings/r/source.mp4",
      contentType: "video/mp4",
    });
    // The token is a header only: never part of the URL the bridge persists.
    expect(uploadUrl).not.toContain("token-1");
  });

  it("refuses an upload URL on another origin", async () => {
    server.locationOverride = "http://storage.example.invalid/storage/v1/upload/resumable/sign/abc";
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    await expect(client.create(createOptions())).rejects.toThrow("not on the origin");
  });

  it("uploads the file in chunks streamed from disk; the server holds identical bytes", async () => {
    const before = await fs.stat(filePath);
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const uploadUrl = await client.create(createOptions());
    const progress: number[] = [];
    const first = await client.patchChunk({
      uploadUrl,
      token: "token-1",
      filePath,
      offset: 0,
      length: 128 * 1024,
      onBytesSent: (sent) => progress.push(sent),
    });
    expect(first).toBe(128 * 1024);
    expect(progress).toEqual([64 * 1024, 128 * 1024]);
    expect(await uploadAll(client, uploadUrl, "token-1", first, 128 * 1024)).toBe(content.length);

    expect(sha256(onlyUpload().data)).toBe(sha256(content));
    const patches = server.requests.filter((request) => request.method === "PATCH");
    expect(patches.map((request) => request.headers["content-type"])).toEqual(
      patches.map(() => "application/offset+octet-stream"),
    );
    // The local file is only read.
    const after = await fs.stat(filePath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(sha256(await fs.readFile(filePath))).toBe(sha256(content));
  });

  it("resumes after an interrupted chunk at the offset the server reports (identical sha256)", async () => {
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const uploadUrl = await client.create(createOptions());
    await client.patchChunk({ uploadUrl, token: "token-1", filePath, offset: 0, length: 100_000 });

    server.dropNextPatchAfterBytes = 30_000;
    await expect(
      client.patchChunk({ uploadUrl, token: "token-1", filePath, offset: 100_000, length: 100_000 }),
    ).rejects.toBeDefined();

    const offset = await client.getOffset({ uploadUrl, token: "token-1" });
    expect(offset).toBe(130_000);
    await uploadAll(client, uploadUrl, "token-1", offset, 100_000);
    expect(server.count("POST")).toBe(1);
    expect(sha256(onlyUpload().data)).toBe(sha256(content));
  });

  it("reports a wrong offset as a conflict", async () => {
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const uploadUrl = await client.create(createOptions());
    const error = await client
      .patchChunk({ uploadUrl, token: "token-1", filePath, offset: 4096, length: 1024 })
      .catch((caught: unknown) => caught);
    expect(isTusOffsetConflict(error)).toBe(true);
    expect(await client.getOffset({ uploadUrl, token: "token-1" })).toBe(0);
  });

  it("reports an expired token as a refusal and continues the same upload with a new one", async () => {
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const uploadUrl = await client.create(createOptions());
    await client.patchChunk({ uploadUrl, token: "token-1", filePath, offset: 0, length: 100_000 });

    server.validTokens.clear();
    server.validTokens.add("token-2");
    const error = await client
      .patchChunk({ uploadUrl, token: "token-1", filePath, offset: 100_000, length: 100_000 })
      .catch((caught: unknown) => caught);
    expect(isTusTokenRefusal(error)).toBe(true);
    // Neither the token nor the response body is part of the error message.
    expect(String((error as Error).message)).toBe("tus PATCH failed with HTTP 403");

    const offset = await client.getOffset({ uploadUrl, token: "token-2" });
    expect(offset).toBe(100_000);
    await uploadAll(client, uploadUrl, "token-2", offset, 100_000);
    expect(sha256(onlyUpload().data)).toBe(sha256(content));
  });

  it("reports an unknown upload URL as gone", async () => {
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT });
    const error = await client
      .getOffset({ uploadUrl: `${server.endpoint}/${randomUUID()}`, token: "token-1" })
      .catch((caught: unknown) => caught);
    expect(isTusUploadGone(error)).toBe(true);
  });

  it("classifies storage answers", () => {
    expect(isTusTokenRefusal(new TusHttpError("POST", 401, ""))).toBe(true);
    expect(isTusTokenRefusal(new TusHttpError("POST", 400, "Invalid Compact JWS"))).toBe(true);
    expect(isTusTokenRefusal(new TusHttpError("POST", 400, "Payload too large"))).toBe(false);
    expect(isTusTokenRefusal(new Error("socket hang up"))).toBe(false);
    expect(isTusUploadGone(new TusHttpError("HEAD", 410, ""))).toBe(true);
    expect(isTusUploadGone(new TusHttpError("HEAD", 500, ""))).toBe(false);
    expect(isTusOffsetConflict(new TusHttpError("PATCH", 409, ""))).toBe(true);
  });

  it("paces a chunk to the throttle in slices of at most 64 KiB", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const client = new TusUploadClient({
      transport: LOCAL_TRANSPORT,
      maxKbps: 800, // 100 000 bytes per second
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    const uploadUrl = await client.create(createOptions());
    const progress: number[] = [];
    await client.patchChunk({
      uploadUrl,
      token: "token-1",
      filePath,
      offset: 0,
      length: 200_000,
      onBytesSent: (sent) => progress.push(sent),
    });
    expect(Math.max(...progress.map((sent, index) => sent - (progress[index - 1] ?? 0)))).toBeLessThanOrEqual(64 * 1024);
    // 200 000 bytes at 100 000 bytes per second take two seconds.
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeCloseTo(2000, 0);
  });

  it("does not sleep without a throttle", async () => {
    const sleep = jest.fn(async () => undefined);
    const client = new TusUploadClient({ transport: LOCAL_TRANSPORT, sleep });
    const uploadUrl = await client.create(createOptions());
    await client.patchChunk({ uploadUrl, token: "token-1", filePath, offset: 0, length: 200_000 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("reads the throttle setting as a positive integer of kbit/s", () => {
    expect(readRecordingUploadMaxKbps(undefined)).toBeNull();
    expect(readRecordingUploadMaxKbps("")).toBeNull();
    expect(readRecordingUploadMaxKbps("0")).toBeNull();
    expect(readRecordingUploadMaxKbps("-5")).toBeNull();
    expect(readRecordingUploadMaxKbps("1.5")).toBeNull();
    expect(readRecordingUploadMaxKbps("fast")).toBeNull();
    expect(readRecordingUploadMaxKbps(" 8000 ")).toBe(8000);
  });

  describe("URL guard of the production transport", () => {
    it.each([
      ["plain http", `http://storage.example${TUS_SIGNED_ENDPOINT_PATH}`],
      ["an IP literal", `https://127.0.0.1${TUS_SIGNED_ENDPOINT_PATH}`],
      ["another port", `https://storage.example:8443${TUS_SIGNED_ENDPOINT_PATH}`],
      ["credentials", `https://user:pw@storage.example${TUS_SIGNED_ENDPOINT_PATH}`],
      ["the unsigned tus endpoint", "https://storage.example/storage/v1/upload/resumable"],
      ["another path", "https://storage.example/anything"],
      ["a query string", `https://storage.example${TUS_SIGNED_ENDPOINT_PATH}?x=1`],
    ])("refuses %s as tus endpoint before any network activity", async (_name, endpoint) => {
      expect(() => parseTusEndpoint(endpoint, GUARDED_TUS_TRANSPORT)).toThrow();
      await expect(new TusUploadClient().create({ ...createOptions(), endpoint })).rejects.toBeDefined();
    });

    it("accepts the signed resumable endpoint on a public https host", () => {
      const url = parseTusEndpoint(`https://project.supabase.co${TUS_SIGNED_ENDPOINT_PATH}`, GUARDED_TUS_TRANSPORT);
      expect(url.origin).toBe("https://project.supabase.co");
    });

    it("refuses a persisted upload URL that does not pass the guard", async () => {
      const client = new TusUploadClient();
      await expect(client.getOffset({ uploadUrl: "http://127.0.0.1:1/x", token: "t" })).rejects.toBeDefined();
      await expect(
        client.patchChunk({ uploadUrl: "https://10.0.0.1/x", token: "t", filePath, offset: 0, length: 1 }),
      ).rejects.toBeDefined();
    });
  });

  describe("with the recording uploader (end to end against the fake server)", () => {
    const CHUNK = 64 * 1024;

    /** In-memory stores shared by two uploader instances: what survives a bridge restart. */
    const createDisk = () => {
      let records: RecordingUploadRecordT[] = [];
      let settings: RecordingUploadSettingsT = { enabled: true, updated_at_ms: 1 };
      return {
        queueStore: {
          load: async () => structuredClone(records),
          save: async (next: RecordingUploadRecordT[]) => {
            records = structuredClone(next);
          },
        },
        settingsStore: {
          load: async () => settings,
          save: async (next: RecordingUploadSettingsT) => {
            settings = next;
          },
        },
        records: () => records,
      };
    };

    const createPlatform = () => {
      const recordingId = randomUUID();
      const calls = { begin: 0, complete: [] as Array<{ size_bytes: number; sha256: string }>, abort: 0 };
      let tokenCounter = 1;
      const platform: RecordingUploadPlatformT = {
        begin: async (): Promise<RecordingUploadGrantT> => {
          calls.begin += 1;
          const token = `token-${tokenCounter}`;
          tokenCounter += 1;
          // A new token replaces the old one, as an expiry would.
          server.validTokens.clear();
          server.validTokens.add(token);
          return {
            state: "uploading",
            recording_id: recordingId,
            storage_path: `orgs/o/recordings/${recordingId}/source.mp4`,
            bucket: "postpro-media",
            content_type: "video/mp4",
            tus_endpoint: server.endpoint,
            token,
            token_ttl_s: 7200,
            chunk_size_bytes: CHUNK,
          };
        },
        complete: async (request) => {
          calls.complete.push({ size_bytes: request.size_bytes, sha256: request.sha256 });
        },
        abort: async () => {
          calls.abort += 1;
        },
      };
      return { platform, calls };
    };

    const queuedRecord = async (): Promise<RecordingUploadRecordT> => {
      const stat = await fs.stat(filePath);
      return {
        id: randomUUID(),
        file_path: filePath,
        size_bytes: stat.size,
        mtime_ms: stat.mtimeMs,
        codec: "h264",
        container: "mp4",
        width: 1920,
        height: 1080,
        fps: 30,
        duration_ms: 60_000,
        recorded_at_ms: 1_000,
        enqueued_at_ms: 2_000,
        state: "queued",
        sha256: null,
        recording_id: null,
        upload_url: null,
        bytes_uploaded: 0,
        restarted: false,
        attempts: 0,
        next_attempt_at: 0,
        error_code: null,
        updated_at_ms: 2_000,
      };
    };

    /** Local transport that injects a fault right before the third PATCH leaves. */
    const beforeThirdPatch = (inject: () => void): TusTransportT => {
      let patches = 0;
      return {
        ...LOCAL_TRANSPORT,
        request: (url, options, onResponse) => {
          if (options.method === "PATCH") {
            patches += 1;
            if (patches === 3) {
              inject();
            }
          }
          return LOCAL_TRANSPORT.request(url, options, onResponse);
        },
      };
    };

    const createUploader = (
      disk: ReturnType<typeof createDisk>,
      platform: RecordingUploadPlatformT,
      now: () => number,
      transport: TusTransportT = LOCAL_TRANSPORT,
    ) =>
      new RecordingUploader({
        queueStore: disk.queueStore,
        settingsStore: disk.settingsStore,
        platform,
        tus: new TusUploadClient({ transport }),
        publish: jest.fn(),
        logger: { info: jest.fn(), warn: jest.fn() },
        now,
        startupDrainDelayMs: 60 * 60_000,
      });

    it("network loss mid-upload, bridge restart, resume: one upload, identical sha256, file untouched", async () => {
      const disk = createDisk();
      await disk.queueStore.save([await queuedRecord()]);
      const { platform, calls } = createPlatform();
      let clock = 10_000;
      const before = await fs.stat(filePath);

      // The connection dies in the third chunk.
      const first = createUploader(
        disk,
        platform,
        () => clock,
        beforeThirdPatch(() => {
          server.dropNextPatchAfterBytes = 10_000;
        }),
      );
      await first.initialize();
      await first.drain();

      const waiting = disk.records()[0];
      expect(waiting.state).toBe("uploading");
      expect(waiting.attempts).toBe(1);
      expect(waiting.bytes_uploaded).toBe(2 * CHUNK);
      expect(waiting.next_attempt_at).toBeGreaterThan(clock);
      expect(waiting.sha256).toBe(sha256(content));
      // The token is never written to disk.
      expect(JSON.stringify(disk.records())).not.toMatch(/token-\d/);
      await first.shutdown();

      // Bridge restart: a new process reads the queue and continues where the server is.
      clock += 60 * 60_000;
      const second = createUploader(disk, platform, () => clock);
      await second.initialize();
      await second.drain();

      const done = disk.records()[0];
      expect(done.state).toBe("done");
      expect(done.bytes_uploaded).toBe(content.length);
      expect(server.count("POST")).toBe(1);
      expect(server.count("HEAD")).toBeGreaterThanOrEqual(1);
      expect(sha256(onlyUpload().data)).toBe(sha256(content));
      expect(calls.complete).toEqual([{ size_bytes: content.length, sha256: sha256(content) }]);
      expect(calls.abort).toBe(0);
      const after = await fs.stat(filePath);
      expect(after.mtimeMs).toBe(before.mtimeMs);
      expect(after.size).toBe(before.size);
      await second.shutdown();
    });

    it("a token that expires mid-upload is re-issued and the same upload continues", async () => {
      const disk = createDisk();
      await disk.queueStore.save([await queuedRecord()]);
      const { platform, calls } = createPlatform();
      // The storage server forgets the token after the second chunk.
      const uploader = createUploader(
        disk,
        platform,
        () => 10_000,
        beforeThirdPatch(() => server.validTokens.clear()),
      );
      await uploader.initialize();
      await uploader.drain();

      expect(disk.records()[0].state).toBe("done");
      expect(calls.begin).toBe(2);
      expect(server.count("POST")).toBe(1);
      expect(sha256(onlyUpload().data)).toBe(sha256(content));
      await uploader.shutdown();
    });

    it("an upload URL the server no longer knows starts a new upload from byte 0", async () => {
      const disk = createDisk();
      const record = await queuedRecord();
      await disk.queueStore.save([
        { ...record, state: "uploading", sha256: sha256(content), upload_url: `${server.endpoint}/${randomUUID()}`, bytes_uploaded: CHUNK },
      ]);
      const { platform } = createPlatform();
      const uploader = createUploader(disk, platform, () => 10_000);
      await uploader.initialize();
      await uploader.drain();

      expect(disk.records()[0].state).toBe("done");
      expect(server.count("POST")).toBe(1);
      expect(sha256(onlyUpload().data)).toBe(sha256(content));
      await uploader.shutdown();
    });
  });
});
