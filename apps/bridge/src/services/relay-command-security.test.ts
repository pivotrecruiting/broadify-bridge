import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import type { KeyObject } from "node:crypto";
import {
  stableStringify,
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
