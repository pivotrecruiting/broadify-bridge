import { createReadStream } from "node:fs";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { guardedLookup, parseGuardedUrl } from "../meeting/media-download.js";

const TUS_VERSION = "1.0.0";
const REQUEST_IDLE_TIMEOUT_MS = 60_000;
const MAX_ERROR_BODY_BYTES = 2048;
/** Largest slice written to the socket at once; the pacing unit of the throttle. */
const MAX_SLICE_BYTES = 64 * 1024;
const MIN_SLICE_BYTES = 1024;

/** Path of the Supabase tus endpoint that accepts a signed upload token (`x-signature`). */
export const TUS_SIGNED_ENDPOINT_PATH = "/storage/v1/upload/resumable/sign";

/** Environment setting of the upload throttle, in kbit/s; unset = unlimited. */
export const RECORDING_UPLOAD_MAX_KBPS_ENV_KEY = "BRIDGE_RECORDING_UPLOAD_MAX_KBPS";

/**
 * Reads the throttle setting: a positive integer in kbit/s. Anything else
 * (unset, empty, zero, not a number) means unlimited.
 */
export function readRecordingUploadMaxKbps(
  raw: string | undefined = process.env[RECORDING_UPLOAD_MAX_KBPS_ENV_KEY],
): number | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const kbps = Number(value);
  return Number.isSafeInteger(kbps) && kbps > 0 ? kbps : null;
}

/**
 * How the client reaches the storage server. The default validates every URL
 * with the guard of the relay media commands and re-checks every resolved
 * address at connect; tests replace it to talk to a local server.
 */
export type TusTransportT = {
  parseUrl: (rawUrl: string) => URL;
  request: (
    url: URL,
    options: RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => ClientRequest;
};

export const GUARDED_TUS_TRANSPORT: TusTransportT = {
  parseUrl: parseGuardedUrl,
  request: (url, options, onResponse) =>
    httpsRequest(url, { ...options, lookup: guardedLookup }, onResponse),
};

/**
 * The storage server answered a tus request with an unexpected status.
 * `detail` is the start of the response body, kept for classification only:
 * it is never logged.
 */
export class TusHttpError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`tus ${method} failed with HTTP ${status}`);
    this.name = "TusHttpError";
  }
}

/** The server no longer accepts the upload token (expired or invalid signature). */
export function isTusTokenRefusal(error: unknown): boolean {
  if (!(error instanceof TusHttpError)) {
    return false;
  }
  if (error.status === 401 || error.status === 403) {
    return true;
  }
  return error.status === 400 && /jws|jwt|signature|token/i.test(error.detail);
}

/** The server no longer knows the upload URL (expired or already finalized). */
export function isTusUploadGone(error: unknown): boolean {
  return error instanceof TusHttpError && (error.status === 404 || error.status === 410);
}

/** The offset sent with a PATCH does not match the server's (tus 409). */
export function isTusOffsetConflict(error: unknown): boolean {
  return error instanceof TusHttpError && error.status === 409;
}

/**
 * Validates the tus endpoint handed out by the platform: it must pass the
 * transport's URL policy and be exactly the signed resumable endpoint.
 */
export function parseTusEndpoint(rawUrl: string, transport: TusTransportT): URL {
  const url = transport.parseUrl(rawUrl);
  if (url.pathname !== TUS_SIGNED_ENDPOINT_PATH || url.search || url.hash) {
    throw new Error("Unexpected tus endpoint.");
  }
  return url;
}

export type TusUploadClientOptionsT = {
  transport?: TusTransportT;
  /** Throttle in kbit/s; null = unlimited. */
  maxKbps?: number | null;
  idleTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type TusCreateOptionsT = {
  endpoint: string;
  token: string;
  sizeBytes: number;
  bucket: string;
  objectName: string;
  contentType: string;
  signal?: AbortSignal;
};

export type TusPatchOptionsT = {
  uploadUrl: string;
  token: string;
  filePath: string;
  /** Offset of the first byte, as the server reported it. */
  offset: number;
  /** Bytes of this chunk. */
  length: number;
  signal?: AbortSignal;
  /** Called with the bytes handed to the socket so far in this chunk (live progress). */
  onBytesSent?: (bytesSent: number) => void;
};

type TusResponseT = { status: number; headers: IncomingMessage["headers"]; body: string };

const encodeMetadata = (metadata: Record<string, string>): string =>
  Object.entries(metadata)
    .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
    .join(",");

const readOffsetHeader = (response: TusResponseT, method: string): number => {
  const raw = response.headers["upload-offset"];
  const value = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TusHttpError(method, response.status, "missing Upload-Offset");
  }
  return value;
};

/**
 * Minimal tus 1.0 client for a signed Supabase Storage upload: exactly the
 * subset that was verified against the storage server (create with POST,
 * offset with HEAD, data with PATCH). The file is streamed from disk in
 * bounded slices and opened read-only; nothing is buffered beyond one slice.
 * The token travels in `x-signature` and is never part of a URL, an error
 * message or a log line.
 */
export class TusUploadClient {
  private readonly transport: TusTransportT;
  private readonly bytesPerSecond: number | null;
  private readonly idleTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(options: TusUploadClientOptionsT = {}) {
    this.transport = options.transport ?? GUARDED_TUS_TRANSPORT;
    this.bytesPerSecond = options.maxKbps ? (options.maxKbps * 1000) / 8 : null;
    this.idleTimeoutMs = options.idleTimeoutMs ?? REQUEST_IDLE_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
  }

  /** The transport's URL policy, for callers that validate a URL before using it. */
  get urlTransport(): TusTransportT {
    return this.transport;
  }

  /**
   * Creates the upload on the server.
   *
   * @returns The upload URL (`Location`), on the same origin as the endpoint.
   */
  async create(options: TusCreateOptionsT): Promise<string> {
    const endpoint = parseTusEndpoint(options.endpoint, this.transport);
    const response = await this.send(endpoint, "POST", options.token, options.signal, {
      "upload-length": String(options.sizeBytes),
      "upload-metadata": encodeMetadata({
        bucketName: options.bucket,
        objectName: options.objectName,
        contentType: options.contentType,
      }),
      "content-length": "0",
    });
    if (response.status !== 201) {
      throw new TusHttpError("POST", response.status, response.body);
    }
    const location = response.headers.location;
    if (!location) {
      throw new TusHttpError("POST", response.status, "missing Location");
    }
    const uploadUrl = this.transport.parseUrl(new URL(location, endpoint).toString());
    if (uploadUrl.origin !== endpoint.origin) {
      throw new Error("The upload URL is not on the origin of the tus endpoint.");
    }
    return uploadUrl.toString();
  }

  /** Asks the server how many bytes of the upload it holds. */
  async getOffset(options: { uploadUrl: string; token: string; signal?: AbortSignal }): Promise<number> {
    const url = this.transport.parseUrl(options.uploadUrl);
    const response = await this.send(url, "HEAD", options.token, options.signal, {});
    if (response.status !== 200 && response.status !== 204) {
      throw new TusHttpError("HEAD", response.status, response.body);
    }
    return readOffsetHeader(response, "HEAD");
  }

  /**
   * Sends one chunk of the file, streamed from disk.
   *
   * @returns The server's offset after the chunk.
   */
  async patchChunk(options: TusPatchOptionsT): Promise<number> {
    const url = this.transport.parseUrl(options.uploadUrl);
    const response = await this.send(
      url,
      "PATCH",
      options.token,
      options.signal,
      {
        "upload-offset": String(options.offset),
        "content-type": "application/offset+octet-stream",
        "content-length": String(options.length),
      },
      (request) => this.pumpFile(request, options),
    );
    if (response.status !== 204) {
      throw new TusHttpError("PATCH", response.status, response.body);
    }
    return readOffsetHeader(response, "PATCH");
  }

  private send(
    url: URL,
    method: string,
    token: string,
    signal: AbortSignal | undefined,
    headers: Record<string, string>,
    writeBody?: (request: ClientRequest) => Promise<void>,
  ): Promise<TusResponseT> {
    return new Promise((resolve, reject) => {
      const request = this.transport.request(
        url,
        {
          method,
          signal,
          timeout: this.idleTimeoutMs,
          headers: { "tus-resumable": TUS_VERSION, "x-signature": token, ...headers },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            if (received < MAX_ERROR_BODY_BYTES) {
              chunks.push(chunk.subarray(0, MAX_ERROR_BODY_BYTES - received));
            }
            received += chunk.length;
          });
          response.on("error", reject);
          response.on("end", () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("tus request timed out"));
      });
      request.on("error", reject);
      if (!writeBody) {
        request.end();
        return;
      }
      writeBody(request).then(
        () => request.end(),
        (error: unknown) => {
          request.destroy(error instanceof Error ? error : new Error(String(error)));
          reject(error);
        },
      );
    });
  }

  /**
   * Streams `[offset, offset + length)` of the file into the request, slice
   * by slice, honouring socket backpressure and the throttle. Stops quietly
   * when the request ended early (the server answered before the body was
   * complete): the response decides the outcome then.
   */
  private async pumpFile(request: ClientRequest, options: TusPatchOptionsT): Promise<void> {
    const sliceBytes = this.bytesPerSecond
      ? Math.max(MIN_SLICE_BYTES, Math.min(MAX_SLICE_BYTES, Math.floor(this.bytesPerSecond)))
      : MAX_SLICE_BYTES;
    const stream = createReadStream(options.filePath, {
      flags: "r",
      start: options.offset,
      end: options.offset + options.length - 1,
      highWaterMark: sliceBytes,
    });
    const startedAt = this.now();
    let sent = 0;
    try {
      for await (const slice of stream as AsyncIterable<Buffer>) {
        if (request.destroyed || request.writableEnded) {
          return;
        }
        if (!request.write(slice)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              request.off("drain", done);
              request.off("close", done);
              resolve();
            };
            request.once("drain", done);
            request.once("close", done);
          });
        }
        sent += slice.length;
        options.onBytesSent?.(sent);
        if (this.bytesPerSecond) {
          const dueMs = (sent / this.bytesPerSecond) * 1000;
          const waitMs = dueMs - (this.now() - startedAt);
          if (waitMs > 0) {
            await this.sleep(waitMs);
          }
        }
      }
      if (sent !== options.length) {
        throw new Error("The recording file is shorter than expected.");
      }
    } finally {
      stream.destroy();
    }
  }
}
