/**
 * Single source of truth for which browser origins may talk to the local
 * bridge API. Consumed by both the CORS plugin registration and the request
 * guard, so the reflected CORS headers and the actual access decision can
 * never diverge.
 *
 * Background: the bridge trusts loopback requests. Without an Origin check,
 * any web page open in a local browser can drive the bridge (its JS requests
 * arrive from 127.0.0.1), and `origin: true` CORS lets it read the responses.
 *
 * Requests without an Origin header stay allowed: native clients, curl and
 * passive <img> loads do not send one. Browsers always attach Origin to
 * cross-origin fetch/XHR/WebSocket requests, which is exactly the surface
 * this list closes.
 */

const DEFAULT_ALLOWED_ORIGINS = [
  // The desktop app loads the webapp from these origins and calls the local
  // bridge API from that page (src/electron/main.ts).
  "https://app.broadify.de",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

/** Hostnames the bridge may be addressed as on the loopback trust path. */
const DEFAULT_ALLOWED_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", "::1"];

const splitEnvList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

export const getAllowedOrigins = (): Set<string> => {
  const origins = new Set(DEFAULT_ALLOWED_ORIGINS);
  for (const origin of splitEnvList(process.env.BRIDGE_ALLOWED_ORIGINS)) {
    origins.add(origin);
  }
  return origins;
};

export const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) {
    return true;
  }
  return getAllowedOrigins().has(origin);
};

/**
 * DNS-rebinding defense for the loopback trust path: a request that reaches
 * the bridge because an attacker-controlled domain resolves to 127.0.0.1
 * carries that domain in its Host header. Legitimate local clients address
 * the bridge by a local name.
 */
export const isAllowedHostHeader = (hostHeader: string | undefined): boolean => {
  if (!hostHeader) {
    // HTTP/1.0 or non-browser clients; not a rebinding vector.
    return true;
  }
  const hostname = hostHeader.startsWith("[")
    ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
    : hostHeader.split(":")[0];
  if (DEFAULT_ALLOWED_HOSTNAMES.includes(hostname)) {
    return true;
  }
  return splitEnvList(process.env.BRIDGE_ALLOWED_HOSTS).includes(hostname);
};
