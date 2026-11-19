import tls from "node:tls";

/**
 * Trust-store status of the running Node.js process.
 *
 * Node.js only trusts its bundled Mozilla CA list by default. Enterprise
 * networks that inspect TLS traffic re-sign outbound connections with a
 * private root CA that is rolled out through the operating-system trust store,
 * so the bridge has to opt into that store (Node >= 22.19: `--use-system-ca`
 * or `NODE_USE_SYSTEM_CA=1`) before it can reach the relay from such a
 * network. This module reports which trust sources are active so support can
 * read the situation from the startup log instead of guessing.
 */

export const SYSTEM_CA_FLAG = "--use-system-ca";
export const SYSTEM_CA_ENV = "NODE_USE_SYSTEM_CA";
export const EXTRA_CA_CERTS_ENV = "NODE_EXTRA_CA_CERTS";

export type SystemCaSourceT = "flag" | "node_options" | "env" | "off";

export type CaCertificateTypeT = "default" | "bundled" | "system" | "extra";

export type CaCertificateCountsT = Record<CaCertificateTypeT, number | null>;

export type TlsTrustStoreStatusT = {
  systemCaEnabled: boolean;
  systemCaSource: SystemCaSourceT;
  extraCaCertsConfigured: boolean;
  /** Certificate count per store; `null` when the runtime cannot report it. */
  caCertificateCounts: CaCertificateCountsT | null;
};

export type GetCaCertificatesT = (type: CaCertificateTypeT) => string[];

export type TlsTrustStoreDepsT = {
  env?: NodeJS.ProcessEnv;
  execArgv?: readonly string[];
  /** Pass `undefined` explicitly to model a runtime without the API. */
  getCACertificates?: GetCaCertificatesT;
};

const CA_CERTIFICATE_TYPES: readonly CaCertificateTypeT[] = [
  "default",
  "bundled",
  "system",
  "extra",
];

const parseNodeOptions = (nodeOptions: string | undefined): string[] =>
  (nodeOptions ?? "").split(/\s+/).filter((token) => token.length > 0);

/**
 * Determine whether, and through which mechanism, the system trust store is
 * enabled. Mirrors Node's precedence: the CLI flag wins over the env variable.
 * Only the literal value `1` enables the env variant, exactly like Node.
 */
export function resolveSystemCaSource(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): SystemCaSourceT {
  if (execArgv.includes(SYSTEM_CA_FLAG)) {
    return "flag";
  }
  if (parseNodeOptions(env.NODE_OPTIONS).includes(SYSTEM_CA_FLAG)) {
    return "node_options";
  }
  if (env[SYSTEM_CA_ENV] === "1") {
    return "env";
  }
  return "off";
}

/**
 * Convenience predicate over `resolveSystemCaSource` for callers that only
 * need to know whether the OS trust store is in use.
 */
export function isSystemCaEnabled(
  env: NodeJS.ProcessEnv = process.env,
  execArgv: readonly string[] = process.execArgv
): boolean {
  return resolveSystemCaSource(env, execArgv) !== "off";
}

/** `tls.getCACertificates` exists since Node 22.15; older runtimes get `undefined`. */
const resolveNativeGetCaCertificates = (): GetCaCertificatesT | undefined =>
  typeof tls.getCACertificates === "function"
    ? (type) => tls.getCACertificates(type)
    : undefined;

const countCaCertificates = (
  getCACertificates: GetCaCertificatesT
): CaCertificateCountsT => {
  const counts = {} as CaCertificateCountsT;
  for (const type of CA_CERTIFICATE_TYPES) {
    try {
      counts[type] = getCACertificates(type).length;
    } catch {
      counts[type] = null;
    }
  }
  return counts;
};

/**
 * Snapshot the trust-store configuration of this process for diagnostics.
 * Never throws: a runtime without the certificate API reports `null` counts.
 */
export function resolveTlsTrustStoreStatus(
  deps: TlsTrustStoreDepsT = {}
): TlsTrustStoreStatusT {
  const env = deps.env ?? process.env;
  const execArgv = deps.execArgv ?? process.execArgv;
  const getCACertificates =
    "getCACertificates" in deps
      ? deps.getCACertificates
      : resolveNativeGetCaCertificates();
  const systemCaSource = resolveSystemCaSource(env, execArgv);

  return {
    systemCaEnabled: isSystemCaEnabled(env, execArgv),
    systemCaSource,
    extraCaCertsConfigured: (env[EXTRA_CA_CERTS_ENV] ?? "").trim().length > 0,
    caCertificateCounts: getCACertificates
      ? countCaCertificates(getCACertificates)
      : null,
  };
}
