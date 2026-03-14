import { buildRelayBridgeAuthChallengePayload } from "./relay-bridge-identity.js";

describe("relay-bridge-identity", () => {
  describe("buildRelayBridgeAuthChallengePayload", () => {
    it("adds purpose and spreads challenge fields", () => {
      const challenge = {
        bridgeId: "bridge-123",
        challengeId: "ch-1",
        nonce: "abc",
        iat: 1000,
        exp: 2000,
        bridgeKeyId: "key-1",
        algorithm: "ed25519" as const,
      };
      const result = buildRelayBridgeAuthChallengePayload(challenge);
      expect(result.purpose).toBe("relay-bridge-auth-v1");
      expect(result.bridgeId).toBe("bridge-123");
      expect(result.challengeId).toBe("ch-1");
      expect(result.nonce).toBe("abc");
      expect(result.iat).toBe(1000);
      expect(result.exp).toBe(2000);
      expect(result.bridgeKeyId).toBe("key-1");
      expect(result.algorithm).toBe("ed25519");
    });
  });
});
