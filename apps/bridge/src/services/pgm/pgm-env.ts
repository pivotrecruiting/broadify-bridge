/**
 * Feature gate for the live program (PGM) preview. Everything behind it is
 * dark until an operator sets BRIDGE_PGM_PREVIEW=1 on the bridge machine;
 * the web app additionally gates on the `feature_live_program` entitlement.
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
  const enabled = env[PGM_PREVIEW_ENV] === "1";
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
