import { z } from "zod";
import type { BridgeSigningIdentityT } from "./bridge-assertion.js";
import { PlatformRequestError, signedPlatformPost, type PlatformFetchT } from "./platform-client.js";
import { TusHttpError } from "./tus-upload-client.js";
import type { UploadableRecordingCodecT } from "./recording-upload-trigger.js";

const BEGIN_ROUTE = "/api/postpro/bridge/recordings/begin";
const COMPLETE_ROUTE = "/api/postpro/bridge/recordings/complete";
const ABORT_ROUTE = "/api/postpro/bridge/recordings/abort";

/** Largest chunk the bridge accepts from the platform (it is streamed, never buffered). */
const MAX_CHUNK_SIZE_BYTES = 256 * 1024 * 1024;

export type RecordingUploadBeginRequestT = {
  client_recording_id: string;
  /** Basename of the local file; the platform derives the title from it. */
  file_name: string;
  size_bytes: number;
  codec: UploadableRecordingCodecT;
  container: "mp4" | "mov";
  width: number;
  height: number;
  fps: number;
  duration_ms: number;
  recorded_at_ms: number;
  bytes_uploaded: number;
};

/**
 * Answer of `begin`. Everything in it is remote input and validated here;
 * unknown keys are tolerated so the platform can add fields.
 */
const RecordingUploadGrantSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("ready"),
    recording_id: z.string().uuid(),
  }),
  z.object({
    state: z.literal("uploading"),
    recording_id: z.string().uuid(),
    storage_path: z.string().min(1).max(1024),
    bucket: z.string().min(1).max(128),
    content_type: z.enum(["video/mp4", "video/quicktime"]),
    tus_endpoint: z.string().url(),
    token: z.string().min(1),
    token_ttl_s: z.number().int().positive(),
    chunk_size_bytes: z.number().int().positive().max(MAX_CHUNK_SIZE_BYTES),
  }),
]);

export type RecordingUploadGrantT = z.infer<typeof RecordingUploadGrantSchema>;
export type RecordingUploadTokenGrantT = Extract<RecordingUploadGrantT, { state: "uploading" }>;

/** The three bridge-signed recording routes of the platform. */
export type RecordingUploadPlatformT = {
  begin: (request: RecordingUploadBeginRequestT) => Promise<RecordingUploadGrantT>;
  complete: (request: { recording_id: string; size_bytes: number; sha256: string }) => Promise<void>;
  abort: (request: { recording_id: string; error_code: string }) => Promise<void>;
};

export function createRecordingUploadPlatform(options: {
  baseUrl: string;
  getIdentity: () => Promise<BridgeSigningIdentityT>;
  fetchFn: PlatformFetchT;
}): RecordingUploadPlatformT {
  const post = <T>(route: string, payload: Record<string, unknown>): Promise<T> =>
    signedPlatformPost<T>({ ...options, route, payload });
  return {
    begin: async (request) => RecordingUploadGrantSchema.parse(await post<unknown>(BEGIN_ROUTE, request)),
    complete: async (request) => {
      await post<unknown>(COMPLETE_ROUTE, request);
    },
    abort: async (request) => {
      await post<unknown>(ABORT_ROUTE, request);
    },
  };
}

/**
 * What the uploader does with a failed platform call:
 * - `retry`: try again later with backoff (transport failure, 401, 5xx, anything unknown);
 * - `cancel`: stop for good without it being a fault of the upload; `disableUpload`
 *   additionally switches the local opt-in hint off (the platform says uploads are not allowed);
 * - `fail`: stop for good with the error;
 * - `restart`: the platform does not accept the stored object; upload once more from byte 0.
 */
export type RecordingUploadErrorReactionT =
  | { kind: "retry" }
  | { kind: "cancel"; errorCode: string; disableUpload: boolean }
  | { kind: "fail"; errorCode: string }
  | { kind: "restart"; errorCode: string };

const cancel =
  (disableUpload: boolean) =>
  (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "cancel", errorCode, disableUpload });
const fail = (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "fail", errorCode });
const restart = (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "restart", errorCode });

/** Reaction per stable error code of the recording routes. */
const REACTION_BY_CODE: Readonly<Record<string, (errorCode: string) => RecordingUploadErrorReactionT>> = {
  bridge_not_linked: cancel(true),
  upload_not_enabled: cancel(true),
  recording_deleted: cancel(false),
  limit_minutes: fail,
  recording_too_large: fail,
  recording_not_found: fail,
  size_mismatch: restart,
  object_missing: restart,
};

/**
 * Maps a failed platform call to the uploader's reaction. The stable `code`
 * of the error body decides; a 400 without a known code is a request the
 * platform will never accept. Everything else is retried.
 */
export function classifyRecordingUploadError(error: unknown): RecordingUploadErrorReactionT {
  if (!(error instanceof PlatformRequestError)) {
    return { kind: "retry" };
  }
  if (error.code && Object.hasOwn(REACTION_BY_CODE, error.code)) {
    return REACTION_BY_CODE[error.code](error.code);
  }
  if (error.status === 400) {
    return fail("invalid_request");
  }
  return { kind: "retry" };
}

/**
 * Code shown for a task that waits for its next attempt. Derived from the
 * kind of failure only; never from a message, URL or response body.
 */
export function describeTransientUploadError(error: unknown): string {
  if (error instanceof PlatformRequestError) {
    return `platform_http_${error.status}`;
  }
  if (error instanceof TusHttpError) {
    return `storage_http_${error.status}`;
  }
  if (error instanceof z.ZodError) {
    return "platform_response_invalid";
  }
  return "network_error";
}
