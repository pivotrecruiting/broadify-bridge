import { request as httpsRequest } from "node:https";
import {
  GuardedDownloadHttpError,
  guardedLookup,
  parseGuardedUrl,
} from "../meeting/media-download.js";

const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Guarded HTTPS PUT for signed storage upload URLs: same URL policy and
 * DNS-rebinding guard as media-download (https only, port 443, no IP
 * literals, every resolved address re-checked). `x-upsert` makes retried
 * uploads to the same server-constructed path idempotent.
 */
export async function uploadGuardedBuffer(
  rawUrl: string,
  body: Buffer,
  contentType: string,
  timeoutMs = DEFAULT_UPLOAD_TIMEOUT_MS,
): Promise<void> {
  const url = parseGuardedUrl(rawUrl);
  await new Promise<void>((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: "PUT",
        lookup: guardedLookup,
        timeout: timeoutMs,
        headers: {
          "content-type": contentType,
          "content-length": body.length,
          "x-upsert": "true",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        response.resume();
        if (status >= 200 && status < 300) {
          response.on("end", () => resolve());
          response.on("error", reject);
          return;
        }
        reject(new GuardedDownloadHttpError(status));
      },
    );
    request.on("timeout", () => {
      request.destroy(new Error("Upload timed out"));
    });
    request.on("error", reject);
    request.end(body);
  });
}
