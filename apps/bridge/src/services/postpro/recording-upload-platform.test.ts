import { generateKeyPairSync } from "node:crypto";
import { ZodError } from "zod";
import { PlatformRequestError, type PlatformFetchT } from "./platform-client.js";
import {
  classifyRecordingUploadError,
  createRecordingUploadPlatform,
  describeTransientUploadError,
  isAnsweredFailure,
  isRecordingRowClosed,
  type RecordingUploadBeginRequestT,
} from "./recording-upload-platform.js";
import { TusHttpError } from "./tus-upload-client.js";

const platformError = (status: number, code: string | null) => new PlatformRequestError("/route", status, code, "detail");

describe("classifyRecordingUploadError", () => {
  it.each([
    [403, "bridge_not_linked", { kind: "cancel", errorCode: "bridge_not_linked", disableUpload: true, abortRow: true }],
    [403, "upload_not_enabled", { kind: "cancel", errorCode: "upload_not_enabled", disableUpload: true, abortRow: true }],
    [410, "recording_deleted", { kind: "cancel", errorCode: "recording_deleted", disableUpload: false, abortRow: false }],
    [409, "recording_not_uploading", { kind: "fail", errorCode: "recording_not_uploading" }],
    [403, "limit_minutes", { kind: "fail", errorCode: "limit_minutes" }],
    [413, "recording_too_large", { kind: "fail", errorCode: "recording_too_large" }],
    [404, "recording_not_found", { kind: "fail", errorCode: "recording_not_found" }],
    [409, "size_mismatch", { kind: "restart", errorCode: "size_mismatch" }],
    [409, "object_missing", { kind: "restart", errorCode: "object_missing" }],
    [400, null, { kind: "fail", errorCode: "invalid_request" }],
    [400, "something_new", { kind: "fail", errorCode: "invalid_request" }],
  ])("HTTP %i with code %p", (status, code, expected) => {
    expect(classifyRecordingUploadError(platformError(status, code))).toEqual(expected);
  });

  it.each([
    [401, null],
    [403, null],
    [403, "something_new"],
    [404, null],
    [429, null],
    [500, null],
    [503, "limit_minutes_typo"],
  ])("retries HTTP %i with code %p", (status, code) => {
    expect(classifyRecordingUploadError(platformError(status, code))).toEqual({ kind: "retry" });
  });

  it("retries transport and storage failures", () => {
    expect(classifyRecordingUploadError(new Error("ECONNRESET"))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError(new TusHttpError("PATCH", 500, ""))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError("nope")).toEqual({ kind: "retry" });
  });

  it.each([400, 413, 415])("an upload the storage refuses to create with HTTP %i fails without a retry", (status) => {
    expect(classifyRecordingUploadError(new TusHttpError("POST", status, "Payload too large"))).toEqual({
      kind: "fail",
      errorCode: `storage_http_${status}`,
    });
  });

  it("retries a create the storage refused for its token, and the same statuses on other requests", () => {
    expect(classifyRecordingUploadError(new TusHttpError("POST", 400, "Invalid Compact JWS"))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError(new TusHttpError("POST", 403, ""))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError(new TusHttpError("POST", 503, ""))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError(new TusHttpError("PATCH", 413, ""))).toEqual({ kind: "retry" });
  });

  it("is not fooled by a code that names an object property", () => {
    expect(classifyRecordingUploadError(platformError(500, "toString"))).toEqual({ kind: "retry" });
    expect(classifyRecordingUploadError(platformError(500, "__proto__"))).toEqual({ kind: "retry" });
  });
});

describe("isAnsweredFailure", () => {
  it("tells an answer of the platform or storage from no answer at all", () => {
    expect(isAnsweredFailure(platformError(503, null))).toBe(true);
    expect(isAnsweredFailure(new TusHttpError("PATCH", 500, ""))).toBe(true);
    expect(isAnsweredFailure(new ZodError([]))).toBe(true);
    expect(isAnsweredFailure(new Error("getaddrinfo ENOTFOUND app.example"))).toBe(false);
    expect(isAnsweredFailure(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("isRecordingRowClosed", () => {
  it("recognises only the platform's recording_not_uploading", () => {
    expect(isRecordingRowClosed(platformError(409, "recording_not_uploading"))).toBe(true);
    expect(isRecordingRowClosed(platformError(409, "size_mismatch"))).toBe(false);
    expect(isRecordingRowClosed(new Error("recording_not_uploading"))).toBe(false);
  });
});

describe("describeTransientUploadError", () => {
  it("names the kind of failure without any message content", () => {
    expect(describeTransientUploadError(platformError(503, null))).toBe("platform_http_503");
    expect(describeTransientUploadError(new TusHttpError("PATCH", 502, "secret body"))).toBe("storage_http_502");
    expect(describeTransientUploadError(new ZodError([]))).toBe("platform_response_invalid");
    expect(describeTransientUploadError(new Error("connect ECONNREFUSED 10.0.0.1:443 /Users/x/file.mp4"))).toBe("network_error");
  });
});

describe("createRecordingUploadPlatform", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    bridgeId: "11111111-1111-4111-8111-111111111111",
    keyId: "bridge-1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  const RECORDING_ID = "22222222-2222-4222-8222-222222222222";
  const request: RecordingUploadBeginRequestT = {
    client_recording_id: "33333333-3333-4333-8333-333333333333",
    file_name: "Broadify-Meeting-1.mp4",
    size_bytes: 10,
    codec: "h264",
    container: "mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    duration_ms: 1000,
    recorded_at_ms: 1,
    bytes_uploaded: 0,
  };
  const grant = {
    recording_id: RECORDING_ID,
    state: "uploading",
    storage_path: `orgs/o/recordings/${RECORDING_ID}/source.mp4`,
    bucket: "postpro-media",
    content_type: "video/mp4",
    tus_endpoint: "https://project.supabase.co/storage/v1/upload/resumable/sign",
    token: "signed-token",
    token_ttl_s: 7200,
    chunk_size_bytes: 6291456,
  };

  const create = (answer: { status: number; body: unknown }) => {
    const calls: Array<{ url: string; headers?: Record<string, string>; body?: string | Buffer }> = [];
    const fetchFn: PlatformFetchT = async (url, init) => {
      calls.push({ url, headers: init?.headers, body: init?.body });
      return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => JSON.stringify(answer.body) };
    };
    const platform = createRecordingUploadPlatform({ baseUrl: "https://app.example/", getIdentity: async () => identity, fetchFn });
    return { platform, calls };
  };

  it("posts bridge-signed requests to the three recording routes", async () => {
    const { platform, calls } = create({ status: 200, body: { success: true, data: grant } });
    await expect(platform.begin(request)).resolves.toEqual(grant);
    await platform.complete({ recording_id: RECORDING_ID, size_bytes: 10, sha256: "a".repeat(64) });
    await platform.abort({ recording_id: RECORDING_ID, error_code: "file_changed" });

    expect(calls.map((call) => call.url)).toEqual([
      "https://app.example/api/postpro/bridge/recordings/begin",
      "https://app.example/api/postpro/bridge/recordings/complete",
      "https://app.example/api/postpro/bridge/recordings/abort",
    ]);
    for (const call of calls) {
      expect(call.headers?.["x-postpro-bridge-assertion"]).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    }
    expect(JSON.parse(String(calls[0].body))).toEqual(request);
  });

  it("accepts the ready answer and tolerates added fields", async () => {
    const { platform } = create({ status: 200, body: { success: true, data: { recording_id: RECORDING_ID, state: "ready", extra: 1 } } });
    await expect(platform.begin(request)).resolves.toEqual({ recording_id: RECORDING_ID, state: "ready" });
  });

  it.each([
    ["a missing token", { ...grant, token: "" }],
    ["a tus endpoint that is no URL", { ...grant, tus_endpoint: "storage" }],
    ["an unknown content type", { ...grant, content_type: "text/html" }],
    ["an unknown state", { ...grant, state: "paused" }],
    ["a chunk size of zero", { ...grant, chunk_size_bytes: 0 }],
  ])("rejects a begin answer with %s", async (_name, data) => {
    const { platform } = create({ status: 200, body: { success: true, data } });
    await expect(platform.begin(request)).rejects.toBeInstanceOf(ZodError);
  });

  it("surfaces status and code of an error answer", async () => {
    const { platform } = create({ status: 403, body: { success: false, error: "Upload is not enabled", code: "upload_not_enabled" } });
    const error = await platform.begin(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformRequestError);
    expect(error).toMatchObject({ status: 403, code: "upload_not_enabled", route: "/api/postpro/bridge/recordings/begin" });
  });

  it("reports an error answer without a code as code null", async () => {
    const { platform } = create({ status: 401, body: { success: false, error: "Invalid assertion" } });
    await expect(platform.begin(request)).rejects.toMatchObject({ status: 401, code: null });
  });
});
