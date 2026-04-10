import { promises as fs } from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as signData,
} from "node:crypto";
import { getBridgeContext } from "./bridge-context.js";
import { base64UrlEncode, stableStringify } from "./relay-command-security.js";

const RELAY_BRIDGE_IDENTITY_DIR = "security";
const RELAY_BRIDGE_IDENTITY_FILE = "relay-bridge-identity.json";
const RELAY_BRIDGE_AUTH_PURPOSE = "relay-bridge-auth-v1";

type RelayBridgeIdentityFileT = {
  version: 1;
  bridgeId: string;
  keyId: string;
  algorithm: "ed25519";
  createdAt: string;
  privateKeyPem: string;
  publicKeyPem: string;
};

export type RelayBridgeEnrollmentPublicKeyT = {
  keyId: string;
  algorithm: "ed25519";
  publicKeyPem: string;
};

export type RelayBridgeAuthChallengePayloadT = {
  purpose: typeof RELAY_BRIDGE_AUTH_PURPOSE;
  bridgeId: string;
  challengeId: string;
  nonce: string;
  iat: number;
  exp: number;
  bridgeKeyId: string;
  algorithm: "ed25519";
};

type RelayBridgeIdentityT = RelayBridgeEnrollmentPublicKeyT & {
  bridgeId: string;
  privateKeyPem: string;
  createdAt: string;
};

let identityCache: RelayBridgeIdentityT | null = null;

const getIdentityFilePath = (): string => {
  const { userDataDir } = getBridgeContext();
  return path.join(
    userDataDir,
    RELAY_BRIDGE_IDENTITY_DIR,
    RELAY_BRIDGE_IDENTITY_FILE,
  );
};

const isIdentityFile = (value: unknown): value is RelayBridgeIdentityFileT => {
  const candidate = value as Partial<RelayBridgeIdentityFileT> | null;
  return (
    !!candidate &&
    candidate.version === 1 &&
    typeof candidate.bridgeId === "string" &&
    typeof candidate.keyId === "string" &&
    candidate.algorithm === "ed25519" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.privateKeyPem === "string" &&
    typeof candidate.publicKeyPem === "string"
  );
};

const toRuntimeIdentity = (file: RelayBridgeIdentityFileT): RelayBridgeIdentityT => {
  return {
    bridgeId: file.bridgeId,
    keyId: file.keyId,
    algorithm: file.algorithm,
    createdAt: file.createdAt,
    privateKeyPem: file.privateKeyPem,
    publicKeyPem: file.publicKeyPem,
  };
};

const generateIdentity = (bridgeId: string): RelayBridgeIdentityT => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    bridgeId,
    keyId: `bridge-${bridgeId.slice(0, 8)}-1`,
    algorithm: "ed25519",
    createdAt: new Date().toISOString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
};

const persistIdentity = async (identity: RelayBridgeIdentityT): Promise<void> => {
  const filePath = getIdentityFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: RelayBridgeIdentityFileT = {
    version: 1,
    bridgeId: identity.bridgeId,
    keyId: identity.keyId,
    algorithm: identity.algorithm,
    createdAt: identity.createdAt,
    privateKeyPem: identity.privateKeyPem,
    publicKeyPem: identity.publicKeyPem,
  };
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
};

const loadOrCreateIdentity = async (): Promise<RelayBridgeIdentityT> => {
  const context = getBridgeContext();
  const bridgeId = context.bridgeId;
  if (!bridgeId) {
    throw new Error("Bridge identity requires bridgeId");
  }

  if (identityCache && identityCache.bridgeId === bridgeId) {
    return identityCache;
  }

  const filePath = getIdentityFilePath();
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isIdentityFile(parsed)) {
      throw new Error("Invalid relay bridge identity file");
    }
    if (parsed.bridgeId !== bridgeId) {
      context.logger.warn(
        "[RelayBridgeIdentity] Stored bridge identity does not match bridgeId; rotating identity",
      );
      throw new Error("Bridge identity bridgeId mismatch");
    }
    identityCache = toRuntimeIdentity(parsed);
    return identityCache;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/ENOENT/.test(message) && !/mismatch/.test(message)) {
      context.logger.warn(
        `[RelayBridgeIdentity] Failed to load identity, generating new one: ${message}`,
      );
    }
  }

  const generated = generateIdentity(bridgeId);
  await persistIdentity(generated);
  identityCache = generated;
  context.logger.info("[RelayBridgeIdentity] Generated relay bridge identity keypair");
  return generated;
};

/**
 * Returns the bridge enrollment public key metadata used during pairing.
 */
export const getRelayBridgeEnrollmentPublicKey =
  async (): Promise<RelayBridgeEnrollmentPublicKeyT> => {
    const identity = await loadOrCreateIdentity();
    return {
      keyId: identity.keyId,
      algorithm: identity.algorithm,
      publicKeyPem: identity.publicKeyPem,
    };
  };

/**
 * Builds the canonical payload that is signed for relay bridge auth.
 */
export const buildRelayBridgeAuthChallengePayload = (
  challenge: Omit<RelayBridgeAuthChallengePayloadT, "purpose">,
): RelayBridgeAuthChallengePayloadT => {
  return {
    purpose: RELAY_BRIDGE_AUTH_PURPOSE,
    ...challenge,
  };
};

/**
 * Signs a relay-issued bridge auth challenge.
 */
export const signRelayBridgeAuthChallenge = async (
  challenge: Omit<RelayBridgeAuthChallengePayloadT, "purpose">,
): Promise<{
  bridgeKeyId: string;
  algorithm: "ed25519";
  signature: string;
}> => {
  const identity = await loadOrCreateIdentity();
  if (challenge.bridgeId !== identity.bridgeId) {
    throw new Error("Bridge auth challenge bridgeId mismatch");
  }
  if (challenge.bridgeKeyId !== identity.keyId) {
    throw new Error("Bridge auth challenge keyId mismatch");
  }
  if (challenge.algorithm !== identity.algorithm) {
    throw new Error("Bridge auth challenge algorithm mismatch");
  }

  const payload = buildRelayBridgeAuthChallengePayload(challenge);
  const privateKey = createPrivateKey(identity.privateKeyPem);
  const signature = signData(null, Buffer.from(stableStringify(payload)), privateKey);

  return {
    bridgeKeyId: identity.keyId,
    algorithm: identity.algorithm,
    signature: base64UrlEncode(signature),
  };
};

/**
 * Parses and validates the stored public key locally (sanity check).
 */
export const validateRelayBridgeEnrollmentPublicKey = async (): Promise<void> => {
  const identity = await loadOrCreateIdentity();
  createPublicKey(identity.publicKeyPem);
};
