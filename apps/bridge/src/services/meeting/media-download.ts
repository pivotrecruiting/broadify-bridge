import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns";
import { PassThrough } from "node:stream";
import type { Readable } from "node:stream";

/**
 * Guarded HTTPS downloader used by relay media commands.
 *
 * The webapp cannot POST files to the local bridge from an HTTPS origin in
 * every browser (Safari blocks active mixed content to 127.0.0.1), so the
 * bridge fetches cloud-hosted assets itself. Because the URL arrives via a
 * relay command it is untrusted input: only direct HTTPS on port 443 to a
 * public address is allowed (SSRF guard), with a size cap and timeout.
 */

export type GuardedDownloadT = {
  stream: Readable;
  contentType: string;
  /** Validators echoed by the origin, used for conditional re-fetches. */
  etag: string | null;
  lastModified: string | null;
};

/** Cache validators sent as If-None-Match / If-Modified-Since. */
export type ConditionalRequestT = {
  etag?: string | null;
  lastModified?: string | null;
};

export type GuardedConditionalDownloadT =
  | { status: "not_modified" }
  | {
      status: "ok";
      body: Buffer;
      contentType: string;
      etag: string | null;
      lastModified: string | null;
    };

/** Non-200/304 response from the origin (carries the HTTP status). */
export class GuardedDownloadHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Download failed with HTTP ${statusCode}.`);
    this.name = "GuardedDownloadHttpError";
    this.statusCode = statusCode;
  }
}

/** URL/SSRF guard, size cap or empty-body rejection (never transient). */
export class GuardedDownloadPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardedDownloadPolicyError";
  }
}

/**
 * True for transport-level failures (DNS, connect/reset, socket timeout,
 * TLS) where a caller may reasonably fall back to a cached copy. HTTP status
 * errors and guard/policy rejections are authoritative answers and are
 * never transient.
 */
export function isTransientDownloadError(error: unknown): boolean {
  if (
    error instanceof GuardedDownloadHttpError ||
    error instanceof GuardedDownloadPolicyError
  ) {
    return false;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || error.message === "Download timed out.";
}

const FORBIDDEN_IPV4_RANGES: Array<[number, number]> = [
  // [network, prefix bits]
  [0x00000000, 8], // 0.0.0.0/8 "this network"
  [0x0a000000, 8], // 10.0.0.0/8 private
  [0x64400000, 10], // 100.64.0.0/10 CGNAT
  [0x7f000000, 8], // 127.0.0.0/8 loopback
  [0xa9fe0000, 16], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16.0.0/12 private
  [0xc0a80000, 16], // 192.168.0.0/16 private
  [0xe0000000, 4], // 224.0.0.0/4 multicast
  [0xf0000000, 4], // 240.0.0.0/4 reserved
];

function ipv4ToInt(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) {
      return null;
    }
    value = value * 256 + octet;
  }
  return value >>> 0;
}

function isForbiddenIpv4(address: string): boolean {
  const value = ipv4ToInt(address);
  if (value === null) {
    return true;
  }
  return FORBIDDEN_IPV4_RANGES.some(([network, prefix]) => {
    const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    return (value & mask) === (network >>> 0 & mask);
  });
}

/**
 * Returns true when the resolved address must not be fetched from a relay
 * command (loopback, private, link-local, ULA, multicast, v4-mapped, ...).
 */
export function isForbiddenAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return isForbiddenIpv4(address);
  }
  if (family !== 6) {
    return true;
  }
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") {
    return true;
  }
  // IPv4-mapped/translated forms carry the embedded v4 policy.
  const mappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedMatch) {
    return isForbiddenIpv4(mappedMatch[1]);
  }
  // fc00::/7 ULA, fe80::/10 link-local, ff00::/8 multicast.
  if (
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("ff")
  ) {
    return true;
  }
  return false;
}

/**
 * Validates the raw URL shape before any network activity.
 */
export function parseGuardedUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GuardedDownloadPolicyError("Invalid download URL.");
  }
  if (url.protocol !== "https:") {
    throw new GuardedDownloadPolicyError("Only HTTPS download URLs are allowed.");
  }
  if (url.username || url.password) {
    throw new GuardedDownloadPolicyError("Credentials in download URLs are not allowed.");
  }
  if (url.port && url.port !== "443") {
    throw new GuardedDownloadPolicyError("Only port 443 download URLs are allowed.");
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) !== 0) {
    throw new GuardedDownloadPolicyError("IP-literal download URLs are not allowed.");
  }
  return url;
}

// Validates every address the socket would actually connect to, so a
// hostname cannot resolve past the guard (no DNS rebinding window).
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, [], 0);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    const forbidden = list.find((entry) => isForbiddenAddress(entry.address));
    if (forbidden || list.length === 0) {
      callback(
        new GuardedDownloadPolicyError("Download host resolves to a non-public address."),
        [],
        0,
      );
      return;
    }
    callback(null, list);
  });
};

type GuardedRequestResultT =
  | { status: "not_modified" }
  | { status: "ok"; download: GuardedDownloadT };

function openGuardedRequest(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
  conditional: ConditionalRequestT | null,
): Promise<GuardedRequestResultT> {
  const url = parseGuardedUrl(rawUrl);
  const headers: Record<string, string> = {};
  if (conditional?.etag) {
    headers["if-none-match"] = conditional.etag;
  } else if (conditional?.lastModified) {
    headers["if-modified-since"] = conditional.lastModified;
  }
  return new Promise((resolve, reject) => {
    const request = httpsGet(
      url,
      { lookup: guardedLookup, timeout: timeoutMs, headers },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status === 304 && conditional) {
          response.resume();
          resolve({ status: "not_modified" });
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new GuardedDownloadHttpError(status));
          return;
        }
        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (declaredLength > maxBytes) {
          response.destroy();
          reject(new GuardedDownloadPolicyError("Download exceeds the allowed size."));
          return;
        }
        const output = new PassThrough();
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            const error = new GuardedDownloadPolicyError("Download exceeds the allowed size.");
            response.destroy(error);
            output.destroy(error);
          }
        });
        response.on("error", (error) => output.destroy(error));
        response.pipe(output);
        resolve({
          status: "ok",
          download: {
            stream: output,
            contentType:
              readSingleHeader(response.headers["content-type"]) ?? "",
            etag: readSingleHeader(response.headers.etag),
            lastModified: readSingleHeader(response.headers["last-modified"]),
          },
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Download timed out."));
    });
    request.on("error", reject);
  });
}

/**
 * Opens a guarded HTTPS download stream (no redirects) with a byte cap.
 * The returned stream errors when the cap or timeout is exceeded.
 */
export async function openGuardedDownload(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<GuardedDownloadT> {
  const result = await openGuardedRequest(rawUrl, maxBytes, timeoutMs, null);
  if (result.status !== "ok") {
    // Unreachable without conditional headers; keep the type narrow.
    throw new GuardedDownloadHttpError(304);
  }
  return result.download;
}

async function readStreamFully(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  if (body.length === 0) {
    throw new GuardedDownloadPolicyError("Downloaded file is empty.");
  }
  return body;
}

/**
 * Like downloadGuardedBuffer, but sends the stored validators as a
 * conditional request and reports a 304 instead of re-downloading.
 */
export async function downloadGuardedBufferConditional(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
  conditional: ConditionalRequestT,
): Promise<GuardedConditionalDownloadT> {
  const result = await openGuardedRequest(
    rawUrl,
    maxBytes,
    timeoutMs,
    conditional,
  );
  if (result.status === "not_modified") {
    return result;
  }
  const { stream, contentType, etag, lastModified } = result.download;
  return {
    status: "ok",
    body: await readStreamFully(stream),
    contentType,
    etag,
    lastModified,
  };
}

/**
 * Downloads a small guarded asset fully into memory.
 */
export async function downloadGuardedBuffer(
  rawUrl: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ body: Buffer; contentType: string }> {
  const { stream, contentType } = await openGuardedDownload(
    rawUrl,
    maxBytes,
    timeoutMs,
  );
  return { body: await readStreamFully(stream), contentType };
}

function readSingleHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}
