import { createHash, createPrivateKey, randomUUID, sign } from "node:crypto";

export const POSTPRO_BRIDGE_ASSERTION_HEADER = "x-postpro-bridge-assertion";
export const POSTPRO_BRIDGE_ISSUER = "broadify-bridge";
const TTL_SECONDS = 30;

export type BridgeSigningIdentityT = { bridgeId: string; keyId: string; privateKeyPem: string };

/** Stable JSON: sorted keys, no whitespace (same as Python json.dumps(sort_keys, separators)). */
export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
};

const b64url = (buf: Buffer): string => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");

/**
 * Short-lived Ed25519 assertion for /api/postpro/bridge/* (verified by
 * services/server/postpro-bridge-auth.ts in the web app). Binds the exact
 * request body bytes via payload_hash. Claim names follow the worker format:
 * `worker_id` carries the bridge id.
 */
export function buildBridgeAssertion(rawBody: string, identity: BridgeSigningIdentityT, nowSec = Math.floor(Date.now() / 1000)): string {
  const claims = {
    iss: POSTPRO_BRIDGE_ISSUER,
    worker_id: identity.bridgeId,
    job_id: null,
    kid: identity.keyId,
    iat: nowSec,
    exp: nowSec + TTL_SECONDS,
    jti: randomUUID(),
    payload_hash: createHash("sha256").update(rawBody, "utf8").digest("hex"),
  };
  const body = Buffer.from(stableStringify(claims), "utf8");
  const signature = sign(null, body, createPrivateKey(identity.privateKeyPem));
  return `${b64url(body)}.${b64url(signature)}`;
}
