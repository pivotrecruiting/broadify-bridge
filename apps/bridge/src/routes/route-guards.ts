import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyReply, FastifyRequest } from "fastify";

import { isAllowedHostHeader, isAllowedOrigin } from "./origin-allowlist.js";

type AuthFailure = {
  status: number;
  message: string;
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

/** Constant-time token comparison; hashing first equalizes the lengths. */
const tokensMatch = (provided: string, expected: string): boolean => {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

const normalizeIp = (ip: string): string => {
  if (ip.startsWith("::ffff:")) {
    return ip.slice("::ffff:".length);
  }
  return ip;
};

const getHeaderToken = (request: FastifyRequest): string | null => {
  const rawHeader =
    request.headers["x-bridge-auth"] ?? request.headers["authorization"];
  if (!rawHeader) {
    return null;
  }
  const value = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice("bearer ".length).trim();
  }
  return trimmed;
};

export const getAuthFailure = (request: FastifyRequest): AuthFailure | null => {
  // A cross-origin browser request always carries an Origin header; anything
  // not on the allowlist is rejected regardless of source IP. Loopback alone
  // is no authorization - any web page open in a local browser reaches the
  // bridge from 127.0.0.1.
  const rawOrigin = request.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!isAllowedOrigin(origin)) {
    return { status: 403, message: "Origin not allowed" };
  }

  const ip = request.ip ? normalizeIp(request.ip) : "";
  if (ip && (LOOPBACK_IPS.has(ip) || ip === "127.0.0.1")) {
    // DNS-rebinding defense: an attacker domain resolving to 127.0.0.1 shows
    // up here with its own hostname in the Host header.
    if (!isAllowedHostHeader(request.headers.host)) {
      return { status: 403, message: "Host not allowed" };
    }
    return null;
  }

  const expectedToken = process.env.BRIDGE_API_TOKEN;
  if (!expectedToken) {
    return { status: 403, message: "Local-only endpoint" };
  }

  const providedToken = getHeaderToken(request);
  if (!providedToken || !tokensMatch(providedToken, expectedToken)) {
    return { status: 401, message: "Unauthorized" };
  }

  return null;
};

export const enforceLocalOrToken = (
  request: FastifyRequest,
  reply: FastifyReply
): boolean => {
  const authFailure = getAuthFailure(request);
  if (!authFailure) {
    return true;
  }
  reply.code(authFailure.status).send({
    success: false,
    error: authFailure.message,
  });
  return false;
};
