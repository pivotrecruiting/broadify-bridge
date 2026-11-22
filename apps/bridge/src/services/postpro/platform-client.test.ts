import { createHash, generateKeyPairSync } from "node:crypto";
import {
  PlatformRequestError,
  guardedPlatformFetch,
  platformFetchFor,
  signedPlatformPost,
  type PlatformFetchT,
} from "./platform-client.js";

describe("signedPlatformPost", () => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const identity = {
    bridgeId: "11111111-1111-4111-8111-111111111111",
    keyId: "bridge-1",
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };

  const post = (fetchFn: PlatformFetchT, baseUrl = "https://app.example") =>
    signedPlatformPost<{ id: string }>({
      baseUrl,
      route: "/api/postpro/bridge/recordings/begin",
      payload: { a: 1 },
      getIdentity: async () => identity,
      fetchFn,
    });

  const answer = (status: number, body: string): PlatformFetchT => async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });

  it("signs the exact body bytes and unwraps the data", async () => {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string | Buffer }> = [];
    const fetchFn: PlatformFetchT = async (url, init) => {
      calls.push({ url, ...init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data: { id: "row" } }) };
    };
    await expect(post(fetchFn, "https://app.example/")).resolves.toEqual({ id: "row" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://app.example/api/postpro/bridge/recordings/begin");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toBe('{"a":1}');
    const [claimsPart] = String(calls[0].headers?.["x-postpro-bridge-assertion"]).split(".");
    const claims = JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8"));
    expect(claims).toMatchObject({
      worker_id: identity.bridgeId,
      kid: identity.keyId,
      payload_hash: createHash("sha256").update('{"a":1}', "utf8").digest("hex"),
    });
  });

  it("throws the status and the stable code of an error answer", async () => {
    const error = await post(answer(403, JSON.stringify({ success: false, error: "Not enabled", code: "upload_not_enabled" }))).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PlatformRequestError);
    expect(error).toMatchObject({ status: 403, code: "upload_not_enabled" });
    expect((error as Error).message).toBe("/api/postpro/bridge/recordings/begin: HTTP 403: Not enabled");
  });

  it("has no code for an answer without one, a non-string code or a non-JSON body", async () => {
    await expect(post(answer(401, JSON.stringify({ success: false, error: "Invalid assertion" })))).rejects.toMatchObject({ status: 401, code: null });
    await expect(post(answer(409, JSON.stringify({ success: false, error: "x", code: 7 })))).rejects.toMatchObject({ status: 409, code: null });
    const error = await post(answer(502, "<html>Bad gateway</html>")).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 502, code: null });
    expect((error as Error).message).toContain("HTTP 502: <html>Bad gateway</html>");
  });

  it("treats a 200 without success as an error", async () => {
    await expect(post(answer(200, JSON.stringify({ success: false, error: "nope" })))).rejects.toMatchObject({ status: 200 });
  });

  it("lets a transport failure through unchanged", async () => {
    const failure = new Error("getaddrinfo ENOTFOUND");
    await expect(
      post(async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});

describe("guardedPlatformFetch", () => {
  it.each([
    "http://app.example/api",
    "https://127.0.0.1/api",
    "https://[::1]/api",
    "https://app.example:8443/api",
    "https://user:pw@app.example/api",
    "not a url",
  ])("refuses %p before any network activity", (url) => {
    expect(() => guardedPlatformFetch(url, { method: "POST", body: "{}" })).toThrow();
  });

  it("is the transport of a release-configured address; the operator override uses plain fetch", () => {
    expect(platformFetchFor(true)).toBe(guardedPlatformFetch);
    expect(platformFetchFor(false)).not.toBe(guardedPlatformFetch);
  });
});
