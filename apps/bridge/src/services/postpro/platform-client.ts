import { request as httpsRequest } from "node:https";
import { guardedLookup, parseGuardedUrl } from "../meeting/media-download.js";
import {
  POSTPRO_BRIDGE_ASSERTION_HEADER,
  buildBridgeAssertion,
  type BridgeSigningIdentityT,
} from "./bridge-assertion.js";

const GUARDED_REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const ERROR_TEXT_LIMIT = 200;

export type PlatformFetchT = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Buffer },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/**
 * A bridge-signed platform route answered with an error. `code` is the
 * stable token of the error body (`{ success: false, error, code? }`), null
 * when the route sent none. Transport failures are not wrapped: they surface
 * as the underlying error.
 */
export class PlatformRequestError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    readonly code: string | null,
    detail: string,
  ) {
    super(`${route}: HTTP ${status}: ${detail}`);
    this.name = "PlatformRequestError";
  }
}

export type SignedPlatformPostOptionsT = {
  /** Platform base URL (trusted bridge configuration, never a relay payload). */
  baseUrl: string;
  /** Route below the base URL, e.g. `/api/postpro/bridge/recordings/begin`. */
  route: string;
  payload: Record<string, unknown>;
  getIdentity: () => Promise<BridgeSigningIdentityT>;
  fetchFn: PlatformFetchT;
};

/**
 * POST to a bridge-signed platform route (`/api/postpro/bridge/*`): the body
 * is signed with the bridge's Ed25519 identity (`x-postpro-bridge-assertion`,
 * bound to the exact body bytes) and the `{ success, data }` envelope is
 * unwrapped.
 *
 * @returns The `data` of a successful answer.
 * @throws PlatformRequestError for a non-2xx or unsuccessful answer.
 */
export async function signedPlatformPost<T>(options: SignedPlatformPostOptionsT): Promise<T> {
  const body = JSON.stringify(options.payload);
  const identity = await options.getIdentity();
  const response = await options.fetchFn(`${options.baseUrl.replace(/\/$/, "")}${options.route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [POSTPRO_BRIDGE_ASSERTION_HEADER]: buildBridgeAssertion(body, identity),
    },
    body,
  });
  const text = await response.text();
  let parsed: { success?: boolean; data?: T; error?: string; code?: unknown } | null = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok || !parsed?.success) {
    throw new PlatformRequestError(
      options.route,
      response.status,
      typeof parsed?.code === "string" ? parsed.code : null,
      parsed?.error ?? text.slice(0, ERROR_TEXT_LIMIT),
    );
  }
  return parsed.data as T;
}

/**
 * `fetch`-shaped HTTPS request behind the URL guard of the relay media
 * commands: https only, port 443, no IP literals, every resolved address
 * re-checked at connect (no DNS-rebinding window), no redirects, bounded
 * response. Used for a platform address that came from release
 * configuration.
 */
export const guardedPlatformFetch: PlatformFetchT = (input, init = {}) => {
  const url = parseGuardedUrl(input);
  const body = init.body === undefined ? null : Buffer.from(init.body);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: init.method ?? "GET",
        lookup: guardedLookup,
        timeout: GUARDED_REQUEST_TIMEOUT_MS,
        headers: { ...init.headers, ...(body ? { "content-length": String(body.length) } : {}) },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Platform response exceeds the allowed size."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ ok: status >= 200 && status < 300, status, text: async () => text });
        });
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Platform request timed out."));
    });
    request.on("error", reject);
    request.end(body ?? undefined);
  });
};

/** The transport for a platform address: guarded for a release value, plain `fetch` for the operator override. */
export function platformFetchFor(guarded: boolean): PlatformFetchT {
  return guarded ? guardedPlatformFetch : (input, init) => fetch(input, init);
}
