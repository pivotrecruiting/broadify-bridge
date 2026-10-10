import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { buildBridgeAssertion, stableStringify } from "./bridge-assertion.js";

describe("buildBridgeAssertion", () => {
  test("produces canonical, verifiable claims bound to the body bytes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const identity = { bridgeId: "11111111-1111-4111-8111-111111111111", keyId: "bridge-11111111-1", privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
    const body = '{"session_id":"abc","n":120.0}';
    const token = buildBridgeAssertion(body, identity, 1_800_000_000);
    const [claimsPart, sigPart] = token.split(".");
    const pad = (s: string) => s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
    const claimsRaw = Buffer.from(pad(claimsPart), "base64");
    const claims = JSON.parse(claimsRaw.toString("utf8"));
    expect(claims).toMatchObject({ iss: "broadify-bridge", worker_id: identity.bridgeId, kid: identity.keyId, iat: 1_800_000_000, exp: 1_800_000_030, job_id: null });
    expect(claims.payload_hash).toBe(createHash("sha256").update(body, "utf8").digest("hex"));
    expect(claimsRaw.toString("utf8")).toBe(stableStringify(claims));
    expect(verify(null, claimsRaw, publicKey, Buffer.from(pad(sigPart), "base64"))).toBe(true);
  });
});
