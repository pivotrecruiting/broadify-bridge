/**
 * Windows code-signing policy for electron-builder builds.
 *
 * Pure helper without side effects: it inspects the environment and the CLI
 * arguments and decides whether a Windows build may proceed signed (Azure
 * Trusted Signing), unsigned (explicit local opt-out) or whether the signing
 * configuration is irrelevant because no Windows target is requested.
 */

const AZURE_CODE_SIGNING_ENV_VARS = Object.freeze([
  "AZURE_CODE_SIGNING_PUBLISHER_NAME",
  "AZURE_CODE_SIGNING_ENDPOINT",
  "AZURE_CODE_SIGNING_ACCOUNT_NAME",
  "AZURE_CODE_SIGNING_CERTIFICATE_PROFILE_NAME",
]);

const UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV = "BROADIFY_ALLOW_UNSIGNED_WINDOWS_BUILD";

// electron-builder CLI flags that select the Windows platform. Values may be
// attached with "=" (e.g. "--win=x64"), so only the part before "=" is compared.
const WINDOWS_TARGET_FLAGS = new Set(["--win", "-w", "--windows"]);

/**
 * @param {readonly string[]} argv CLI arguments (process.argv or a slice of it)
 * @returns {boolean} true when a Windows platform target is requested
 */
function isWindowsTargetRequested(argv) {
  if (!Array.isArray(argv)) {
    return false;
  }
  return argv.some((arg) => {
    if (typeof arg !== "string") {
      return false;
    }
    const flag = arg.split("=", 1)[0];
    return WINDOWS_TARGET_FLAGS.has(flag);
  });
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} names of Azure signing variables that are unset or blank
 */
function listMissingAzureCodeSigningEnvVars(env) {
  return AZURE_CODE_SIGNING_ENV_VARS.filter((name) => {
    const value = env?.[name];
    return typeof value !== "string" || value.trim() === "";
  });
}

/**
 * Resolves the Windows signing policy for the current build invocation.
 *
 * @param {{ env: NodeJS.ProcessEnv, argv: readonly string[] }} input
 * @returns {{ mode: "azure" } | { mode: "unsigned_opt_out", missing: string[] } | { mode: "not_applicable", missing: string[] }}
 * @throws {Error} when a Windows target is requested (argv contains --win, -w or
 *   --windows, also in --win=... form), the Azure variables are incomplete and
 *   the opt-out env var is not set to "1".
 */
function resolveWindowsSigningPolicy(input) {
  const env = input?.env ?? {};
  const argv = input?.argv ?? [];
  const missing = listMissingAzureCodeSigningEnvVars(env);

  if (missing.length === 0) {
    return { mode: "azure" };
  }

  if (!isWindowsTargetRequested(argv)) {
    return { mode: "not_applicable", missing };
  }

  if (env[UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV] === "1") {
    return { mode: "unsigned_opt_out", missing };
  }

  throw new Error(
    `Windows signing is not configured (missing: ${missing.join(", ")}). ` +
      `Set ${UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV}=1 for a local unsigned build.`,
  );
}

module.exports = {
  AZURE_CODE_SIGNING_ENV_VARS,
  UNSIGNED_WINDOWS_BUILD_OPT_OUT_ENV,
  isWindowsTargetRequested,
  resolveWindowsSigningPolicy,
};
