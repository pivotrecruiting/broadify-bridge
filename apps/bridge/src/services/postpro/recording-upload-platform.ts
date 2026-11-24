import { z } from "zod";
import type { BridgeSigningIdentityT } from "./bridge-assertion.js";
import { PlatformRequestError, signedPlatformPost, type PlatformFetchT } from "./platform-client.js";
import { TusHttpError, isTusTokenRefusal } from "./tus-upload-client.js";
import type { UploadableRecordingCodecT } from "./recording-upload-trigger.js";

const BEGIN_ROUTE = "/api/postpro/bridge/recordings/begin";
const COMPLETE_ROUTE = "/api/postpro/bridge/recordings/complete";
const ABORT_ROUTE = "/api/postpro/bridge/recordings/abort";
const ROW_CLOSED_CODE = "recording_not_uploading";

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
 * What the uploader does with a failed platform or storage call:
 * - `retry`: try again later with backoff (transport failure, 401, 5xx, anything unknown);
 * - `cancel`: stop for good without it being a fault of the upload; `disableUpload`
 *   additionally switches the local opt-in hint off (the platform says uploads are not allowed),
 *   `abortRow` says the platform still holds an open row that should be closed;
 * - `fail`: stop for good with the error;
 * - `restart`: the platform does not accept the stored object; upload once more from byte 0.
 */
export type RecordingUploadErrorReactionT =
  | { kind: "retry" }
  | { kind: "cancel"; errorCode: string; disableUpload: boolean; abortRow: boolean }
  | { kind: "fail"; errorCode: string }
  | { kind: "restart"; errorCode: string };

const cancel =
  (options: { disableUpload: boolean; abortRow: boolean }) =>
  (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "cancel", errorCode, ...options });
const fail = (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "fail", errorCode });
const restart = (errorCode: string): RecordingUploadErrorReactionT => ({ kind: "restart", errorCode });

/** Reaction per stable error code of the recording routes. */
const REACTION_BY_CODE: Readonly<Record<string, (errorCode: string) => RecordingUploadErrorReactionT>> = {
  bridge_not_linked: cancel({ disableUpload: true, abortRow: true }),
  upload_not_enabled: cancel({ disableUpload: true, abortRow: true }),
  // The row is gone or going: there is nothing left to close.
  recording_deleted: cancel({ disableUpload: false, abortRow: false }),
  limit_minutes: fail,
  recording_too_large: fail,
  recording_not_found: fail,
  // Reached only after the uploader reopened the row once (see isRecordingRowClosed).
  [ROW_CLOSED_CODE]: fail,
  size_mismatch: restart,
  object_missing: restart,
};

/** Statuses of the storage's answer to creating an upload that no retry will change. */
const PERMANENT_CREATE_STATUSES: readonly number[] = [400, 413, 415];

/**
 * `complete` found the platform's row no longer open for this upload (its
 * maintenance closed a stalled upload). A `begin` reopens the row.
 */
export function isRecordingRowClosed(error: unknown): boolean {
  return error instanceof PlatformRequestError && error.code === ROW_CLOSED_CODE;
}

/**
 * The platform or the storage answered (with an error, or with something the
 * bridge cannot use). Everything else is a failure to get an answer at all:
 * no network, DNS, timeout, connection reset.
 */
export function isAnsweredFailure(error: unknown): boolean {
  return error instanceof PlatformRequestError || error instanceof TusHttpError || error instanceof z.ZodError;
}

/**
 * Maps a failed platform or storage call to the uploader's reaction. The
 * stable `code` of the platform's error body decides; a 400 without a known
 * code is a request the platform will never accept, and so is an upload the
 * storage refuses to create for its size or type. Everything else is retried.
 */
export function classifyRecordingUploadError(error: unknown): RecordingUploadErrorReactionT {
  if (
    error instanceof TusHttpError &&
    error.method === "POST" &&
    PERMANENT_CREATE_STATUSES.includes(error.status) &&
    !isTusTokenRefusal(error)
  ) {
    return fail(`storage_http_${error.status}`);
  }
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
