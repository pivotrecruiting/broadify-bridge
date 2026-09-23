import { EXTRA_CA_CERTS_ENV, isSystemCaEnabled } from "./tls-trust-store.js";

/**
 * Human-readable diagnostics for relay socket errors.
 *
 * `ws` re-emits the underlying Node.js error, so TLS failures arrive with the
 * OpenSSL verification code (for example `SELF_SIGNED_CERT_IN_CHAIN` when a
 * TLS-inspecting proxy re-signs the relay connection). Surfacing that code
 * plus a fix hint turns a silent reconnect loop into an actionable support
 * case. Errors without a code keep their message untouched.
 */

export type RelaySocketErrorKindT =
  | "tls_untrusted_chain"
  | "tls_certificate_invalid"
  | "other";

export type RelaySocketErrorInfoT = {
  kind: RelaySocketErrorKindT;
  code: string | null;
  message: string;
};

/** Verification codes meaning the peer chain does not end in a trusted root. */
export const TLS_UNTRUSTED_CHAIN_CODES: ReadonlySet<string> = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_SIGNATURE_FAILURE",
  "CERT_CHAIN_TOO_LONG",
  "CERT_REJECTED",
]);

/** Verification codes meaning the certificate itself is unusable. */
export const TLS_CERTIFICATE_INVALID_CODES: ReadonlySet<string> = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "HOSTNAME_MISMATCH",
]);

const readErrorCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
};

const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const resolveKind = (code: string | null): RelaySocketErrorKindT => {
  if (code === null) {
    return "other";
  }
  if (TLS_UNTRUSTED_CHAIN_CODES.has(code)) {
    return "tls_untrusted_chain";
  }
  if (TLS_CERTIFICATE_INVALID_CODES.has(code)) {
    return "tls_certificate_invalid";
  }
  return "other";
};

/**
 * Classify a socket error by its Node/OpenSSL error code.
 */
export function classifyRelaySocketError(error: unknown): RelaySocketErrorInfoT {
  const code = readErrorCode(error);
  return { kind: resolveKind(code), code, message: readErrorMessage(error) };
}

export type DescribeRelaySocketErrorDepsT = {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
};

/**
 * Build the log text for a relay socket error: the original message, the
 * error code when present, and an operator hint for TLS trust failures.
 */
export function describeRelaySocketError(
  error: unknown,
  deps: DescribeRelaySocketErrorDepsT = {}
): string {
  const { kind, code, message } = classifyRelaySocketError(error);
  if (code === null) {
    return message;
  }

  const base = `${message} (code: ${code})`;
  switch (kind) {
    case "tls_untrusted_chain": {
      const systemCaEnabled = isSystemCaEnabled(deps.env, deps.execArgv);
      return (
        `${base} - relay TLS certificate chain is not trusted by this process, ` +
        "typically because a TLS-inspecting proxy or firewall re-signs the " +
        "connection with a private root CA. " +
        `System trust store: ${systemCaEnabled ? "enabled" : "disabled"}. ` +
        "Fix: install the issuing root CA in the OS trust store, point " +
        `${EXTRA_CA_CERTS_ENV} at its PEM file, or exempt the relay host from TLS inspection.`
      );
    }
    case "tls_certificate_invalid":
      return (
        `${base} - relay TLS certificate was rejected as invalid (expired, not yet ` +
        "valid, revoked, or hostname mismatch). Check the system clock and any " +
        "TLS-inspecting proxy."
      );
    case "other":
      return base;
  }
}
