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
