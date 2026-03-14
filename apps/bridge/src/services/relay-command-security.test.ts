import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  base64UrlDecode,
  stableStringify,
  pruneJtiCache,
  verifySignedRelayCommand,
  type RelayCommandMetaT,
  type SignedRelayCommandMessageT,
} from "./relay-command-security.js";

const toBase64Url = (value: Buffer): string =>
  value
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

const buildSignedMessage = (params: {
  privateKey: KeyObject;
  meta: RelayCommandMetaT;
  payload?: Record<string, unknown>;
  command?: string;
  requestId?: string;
}): SignedRelayCommandMessageT => {
  const requestId = params.requestId ?? "req-1";
  const command = params.command ?? "engine_connect";
  const payload = params.payload ?? { ip: "10.0.0.10", port: 9910 };
  const signingPayload = {
    requestId,
    command,
    payload,
    meta: params.meta,
  };
  const signature = signMessage(
    null,
    Buffer.from(stableStringify(signingPayload)),
    params.privateKey,
  );

  return {
    requestId,
    command,
    payload,
    meta: params.meta,
    signature: toBase64Url(signature),
  };
};

describe("base64UrlDecode", () => {
  it("decodes URL-safe base64 to buffer", () => {
    const encoded = Buffer.from("hello").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    const result = base64UrlDecode(encoded);
    expect(result.toString()).toBe("hello");
  });

  it("handles padding", () => {
    const encoded = "aGVsbG8"; // "hello" in base64
    const result = base64UrlDecode(encoded);
    expect(result.toString()).toBe("hello");
  });
});

describe("stableStringify", () => {
  it("stringifies primitives", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("x")).toBe('"x"');
  });

  it("sorts object keys", () => {
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("handles nested objects", () => {
    expect(stableStringify({ b: { y: 1, x: 2 } })).toBe('{"b":{"x":2,"y":1}}');
  });

  it("handles arrays", () => {
    expect(stableStringify([1, 2])).toBe("[1,2]");
  });
});

describe("pruneJtiCache", () => {
  it("removes expired entries", () => {
    const seenJti = new Map<string, number>([
      ["jti-1", 100],
      ["jti-2", 200],
    ]);
    pruneJtiCache(seenJti, 150, 100);
    expect(seenJti.has("jti-1")).toBe(false);
    expect(seenJti.has("jti-2")).toBe(true);
  });

  it("caps cache size by removing oldest", () => {
    const seenJti = new Map<string, number>([
      ["a", 500],
      ["b", 500],
      ["c", 500],
    ]);
    pruneJtiCache(seenJti, 0, 2);
    expect(seenJti.size).toBeLessThanOrEqual(2);
  });
});

describe("verifySignedRelayCommand", () => {
  it("accepts valid signed command and stores jti", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seenJti = new Map<string, number>();
    const meta: RelayCommandMetaT = {
      bridgeId: "bridge-1",
      orgId: "org-1",
      scope: ["command:engine_connect"],
      iat: 1000,
      exp: 1100,
      jti: "jti-1",
      kid: "kid-1",
    };
    const message = buildSignedMessage({ privateKey, meta });

    await expect(
      verifySignedRelayCommand({
        message,
        bridgeId: "bridge-1",
        getPublicKey: async (kid) => (kid === "kid-1" ? publicKey : undefined),
        seenJti,
        nowSec: 1050,
      }),
    ).resolves.toBeUndefined();

    expect(seenJti.get("jti-1")).toBe(1100);
  });

  it("rejects missing signature", async () => {
    const seenJti = new Map<string, number>();
    await expect(
      verifySignedRelayCommand({
        message: { requestId: "r1", command: "engine_connect" },
        bridgeId: "bridge-1",
        getPublicKey: async () => undefined,
        seenJti,
        nowSec: 1000,
      }),
    ).rejects.toThrow("Missing command signature");
  });

  it("rejects scope mismatch", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seenJti = new Map<string, number>();
    const meta: RelayCommandMetaT = {
      bridgeId: "bridge-1",
      orgId: "org-1",
      scope: ["command:engine_disconnect"],
      iat: 1000,
      exp: 1100,
      jti: "jti-2",
      kid: "kid-1",
    };
    const message = buildSignedMessage({ privateKey, meta });

    await expect(
      verifySignedRelayCommand({
        message,
        bridgeId: "bridge-1",
        getPublicKey: async () => publicKey,
        seenJti,
        nowSec: 1050,
      }),
    ).rejects.toThrow("Scope mismatch");
  });

  it("rejects expired command", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seenJti = new Map<string, number>();
    const meta: RelayCommandMetaT = {
      bridgeId: "bridge-1",
      orgId: "org-1",
      scope: ["command:engine_connect"],
      iat: 900,
      exp: 930,
      jti: "jti-3",
      kid: "kid-1",
    };
    const message = buildSignedMessage({ privateKey, meta });

    await expect(
      verifySignedRelayCommand({
        message,
        bridgeId: "bridge-1",
        getPublicKey: async () => publicKey,
        seenJti,
        nowSec: 1000,
      }),
    ).rejects.toThrow("Command expired");
  });

  it("rejects replayed jti", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seenJti = new Map<string, number>();
    const meta: RelayCommandMetaT = {
      bridgeId: "bridge-1",
      orgId: "org-1",
      scope: ["command:engine_connect"],
      iat: 1000,
      exp: 1200,
      jti: "jti-replay",
      kid: "kid-1",
    };
    const message = buildSignedMessage({ privateKey, meta });

    await verifySignedRelayCommand({
      message,
      bridgeId: "bridge-1",
      getPublicKey: async () => publicKey,
      seenJti,
      nowSec: 1050,
    });

    await expect(
      verifySignedRelayCommand({
        message,
        bridgeId: "bridge-1",
        getPublicKey: async () => publicKey,
        seenJti,
        nowSec: 1060,
      }),
    ).rejects.toThrow("Replay detected");
  });

  it("rejects invalid signature", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const seenJti = new Map<string, number>();
    const meta: RelayCommandMetaT = {
      bridgeId: "bridge-1",
      orgId: "org-1",
      scope: ["command:engine_connect"],
      iat: 1000,
      exp: 1200,
      jti: "jti-badsig",
      kid: "kid-1",
    };
    const message = buildSignedMessage({ privateKey, meta });
    message.payload = { ip: "10.0.0.99", port: 9910 };

    await expect(
      verifySignedRelayCommand({
        message,
        bridgeId: "bridge-1",
        getPublicKey: async () => publicKey,
        seenJti,
        nowSec: 1050,
      }),
    ).rejects.toThrow("Invalid signature");
  });
});
