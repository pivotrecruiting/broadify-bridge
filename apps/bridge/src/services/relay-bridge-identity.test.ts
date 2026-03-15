import { generateKeyPairSync } from "node:crypto";

const mockGetBridgeContext = jest.fn();
jest.mock("./bridge-context.js", () => ({
  getBridgeContext: () => mockGetBridgeContext(),
}));

const mockReadFile = jest.fn();
const mockWriteFile = jest.fn();
const mockMkdir = jest.fn();
jest.mock("node:fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
  },
}));

function createValidIdentityFile(bridgeId: string) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    version: 1 as const,
    bridgeId,
    keyId: `bridge-${bridgeId.slice(0, 8)}-1`,
    algorithm: "ed25519" as const,
    createdAt: new Date().toISOString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

describe("relay-bridge-identity", () => {
  const defaultContext = {
    userDataDir: "/tmp/test-bridge-data",
    bridgeId: "bridge-12345678-abcd",
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    mockGetBridgeContext.mockReturnValue(defaultContext);
  });

  describe("buildRelayBridgeAuthChallengePayload", () => {
    it("adds purpose and spreads challenge fields", () => {
      const { buildRelayBridgeAuthChallengePayload: build } = require("./relay-bridge-identity.js");
      const challenge = {
        bridgeId: "bridge-123",
        challengeId: "ch-1",
        nonce: "abc",
        iat: 1000,
        exp: 2000,
        bridgeKeyId: "key-1",
        algorithm: "ed25519" as const,
      };
      const result = build(challenge);
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

  describe("getRelayBridgeEnrollmentPublicKey", () => {
    it("throws when bridgeId is missing", async () => {
      mockGetBridgeContext.mockReturnValue({
        ...defaultContext,
        bridgeId: undefined,
      });
      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      await expect(getKey()).rejects.toThrow("Bridge identity requires bridgeId");
    });

    it("returns public key from persisted identity file", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(result).toEqual({
        keyId: identityFile.keyId,
        algorithm: "ed25519",
        publicKeyPem: identityFile.publicKeyPem,
      });
      expect(mockReadFile).toHaveBeenCalled();
    });

    it("returns cached identity on second call without reading file", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result1 = await getKey();
      const result2 = await getKey();

      expect(result1).toEqual(result2);
      expect(mockReadFile).toHaveBeenCalledTimes(1);
    });

    it("rotates identity and logs warn when stored identity bridgeId does not match context", async () => {
      const identityFile = createValidIdentityFile("other-bridge-id-xxxx");
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(defaultContext.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Stored bridge identity does not match bridgeId")
      );
      expect(result.keyId).toMatch(new RegExp(`^bridge-${defaultContext.bridgeId!.slice(0, 8)}-1$`));
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("generates new identity and logs warn when file parse fails", async () => {
      mockReadFile.mockResolvedValue("invalid json {{{");
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(result.keyId).toMatch(/^bridge-.+-1$/);
      expect(result.algorithm).toBe("ed25519");
      expect(defaultContext.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to load identity, generating new one")
      );
      expect(mockWriteFile).toHaveBeenCalled();
    });

    it("generates and persists new identity when file is invalid", async () => {
      mockReadFile.mockResolvedValue(JSON.stringify({ version: 99, invalid: true }));
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(result.keyId).toMatch(/^bridge-.+-1$/);
      expect(result.algorithm).toBe("ed25519");
      expect(typeof result.publicKeyPem).toBe("string");
      expect(result.publicKeyPem).toContain("-----BEGIN PUBLIC KEY-----");
      expect(mockWriteFile).toHaveBeenCalled();
      expect(mockMkdir).toHaveBeenCalled();
    });

    it("generates new identity when file does not exist (ENOENT) without logging warn", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT: no such file"));
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(result.keyId).toMatch(/^bridge-.+-1$/);
      expect(defaultContext.logger.warn).not.toHaveBeenCalled();
    });

    it("handles non-Error rejection and logs warn with string message", async () => {
      mockReadFile.mockRejectedValue("unknown rejection");
      mockWriteFile.mockResolvedValue(undefined);
      mockMkdir.mockResolvedValue(undefined);

      const { getRelayBridgeEnrollmentPublicKey: getKey } = require("./relay-bridge-identity.js");
      const result = await getKey();

      expect(result.keyId).toMatch(/^bridge-.+-1$/);
      expect(defaultContext.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("unknown rejection")
      );
    });
  });

  describe("signRelayBridgeAuthChallenge", () => {
    it("throws when challenge bridgeId does not match identity", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { signRelayBridgeAuthChallenge: sign } = require("./relay-bridge-identity.js");
      await expect(
        sign({
          bridgeId: "other-bridge",
          challengeId: "ch-1",
          nonce: "n",
          iat: 1,
          exp: 2,
          bridgeKeyId: identityFile.keyId,
          algorithm: "ed25519",
        })
      ).rejects.toThrow("Bridge auth challenge bridgeId mismatch");
    });

    it("throws when challenge keyId does not match identity", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { signRelayBridgeAuthChallenge: sign } = require("./relay-bridge-identity.js");
      await expect(
        sign({
          bridgeId: identityFile.bridgeId,
          challengeId: "ch-1",
          nonce: "n",
          iat: 1,
          exp: 2,
          bridgeKeyId: "wrong-key-id",
          algorithm: "ed25519",
        })
      ).rejects.toThrow("Bridge auth challenge keyId mismatch");
    });

    it("throws when challenge algorithm does not match identity", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { signRelayBridgeAuthChallenge: sign } = require("./relay-bridge-identity.js");
      await expect(
        sign({
          bridgeId: identityFile.bridgeId,
          challengeId: "ch-1",
          nonce: "n",
          iat: 1,
          exp: 2,
          bridgeKeyId: identityFile.keyId,
          algorithm: "rs256" as "ed25519",
        })
      ).rejects.toThrow("Bridge auth challenge algorithm mismatch");
    });

    it("returns signature when challenge matches identity", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { signRelayBridgeAuthChallenge: sign } = require("./relay-bridge-identity.js");
      const result = await sign({
        bridgeId: identityFile.bridgeId,
        challengeId: "ch-1",
        nonce: "n",
        iat: 1,
        exp: 2,
        bridgeKeyId: identityFile.keyId,
        algorithm: "ed25519",
      });

      expect(result.bridgeKeyId).toBe(identityFile.keyId);
      expect(result.algorithm).toBe("ed25519");
      expect(typeof result.signature).toBe("string");
      expect(result.signature.length).toBeGreaterThan(0);
      expect(result.signature).not.toMatch(/[+/=]/);
    });
  });

  describe("validateRelayBridgeEnrollmentPublicKey", () => {
    it("does not throw when public key is valid", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(JSON.stringify(identityFile));

      const { validateRelayBridgeEnrollmentPublicKey: validate } =
        require("./relay-bridge-identity.js");
      await expect(validate()).resolves.toBeUndefined();
    });

    it("throws when public key PEM is invalid", async () => {
      const identityFile = createValidIdentityFile(defaultContext.bridgeId!);
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          ...identityFile,
          publicKeyPem: "not-valid-pem",
        })
      );

      const { validateRelayBridgeEnrollmentPublicKey: validate } =
        require("./relay-bridge-identity.js");
      await expect(validate()).rejects.toThrow();
    });
  });
});
