import type { FastifyReply, FastifyRequest } from "fastify";

type AuthFailure = {
  status: number;
  message: string;
};

const LOOPBACK_IPS = new Set(["127.0.0.1", "::1"]);

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
  const ip = request.ip ? normalizeIp(request.ip) : "";
  if (ip && (LOOPBACK_IPS.has(ip) || ip === "127.0.0.1")) {
    return null;
  }

  const expectedToken = process.env.BRIDGE_API_TOKEN;
  if (!expectedToken) {
    return { status: 403, message: "Local-only endpoint" };
  }

  const providedToken = getHeaderToken(request);
  if (!providedToken || providedToken !== expectedToken) {
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
