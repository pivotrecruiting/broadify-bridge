/**
 * Kill switch for the live program (PGM) preview. On by default: the helper
 * only starts on demand (source selected or viewer), so an idle bridge pays
 * nothing. BRIDGE_PGM_PREVIEW=0 switches it off on one machine. Who may see
 * the program is decided by the web app's `feature_live_program` entitlement,
 * not here.
 */
export const PGM_PREVIEW_ENV = "BRIDGE_PGM_PREVIEW";
export const PGM_MAX_VIEWERS_ENV = "BRIDGE_PGM_MAX_VIEWERS";
export const PGM_DEFAULT_MAX_VIEWERS = 4;
const PGM_MAX_VIEWERS_CEILING = 16;

export type PgmEnvT = {
  enabled: boolean;
  maxViewers: number;
};

export function parsePgmEnv(env: NodeJS.ProcessEnv = process.env): PgmEnvT {
  const raw = (env[PGM_PREVIEW_ENV] ?? "").trim().toLowerCase();
  const enabled = !(raw === "0" || raw === "false" || raw === "off");
  const rawMax = Number(env[PGM_MAX_VIEWERS_ENV]);
  const maxViewers =
    Number.isInteger(rawMax) && rawMax >= 1
      ? Math.min(rawMax, PGM_MAX_VIEWERS_CEILING)
      : PGM_DEFAULT_MAX_VIEWERS;
  return { enabled, maxViewers };
}

export function isPgmPreviewEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return parsePgmEnv(env).enabled;
}

/**
 * Run-time switch for the Windows live program (ADR-0009, point 8). Off by
 * default: a Windows bridge then answers as before (`pgm_unsupported_bridge`,
 * meeting program `program_stream_unavailable`) and never starts the helper,
 * even when the build switch BROADIFY_PGM_WINDOWS=1 packaged it.
 */
export const PGM_WINDOWS_ENV = "BRIDGE_PGM_WINDOWS";

/**
 * Where this bridge runs the live program (Studio PGM helper and meeting
 * program stream): macOS always, Windows only with BRIDGE_PGM_WINDOWS=1/true/on,
 * any other platform never. The kill switch BRIDGE_PGM_PREVIEW=0 is separate.
 */
export function isPgmPlatformSupported(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): boolean {
  if (platform === "darwin") {
    return true;
  }
  if (platform !== "win32") {
    return false;
  }
  const raw = (env[PGM_WINDOWS_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** Message of the `pgm_unsupported_bridge` refusal; on Windows the run-time switch is what is missing. */
export function pgmUnsupportedPlatformMessage(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "Windows preview not enabled on this bridge."
    : "Live program preview ships for macOS bridges first; Windows follows.";
}
