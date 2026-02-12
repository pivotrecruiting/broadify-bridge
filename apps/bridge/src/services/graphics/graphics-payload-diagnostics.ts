import type { GraphicsSendPayloadT } from "./graphics-schemas.js";

/**
 * Build a structured diagnostic summary for a validated graphics send payload.
 *
 * @param payload Parsed graphics send payload.
 * @returns Compact diagnostic object for logs.
 */
export function summarizeSendPayload(
  payload: GraphicsSendPayloadT
): Record<string, unknown> {
  const manifest = payload.bundle?.manifest ?? {};
  const render =
    typeof (manifest as Record<string, unknown>).render === "object" &&
    (manifest as Record<string, unknown>).render !== null
      ? (manifest as Record<string, unknown>).render
      : null;
  const values = payload.values ?? {};
  const schema =
    typeof payload.bundle?.schema === "object" && payload.bundle.schema !== null
      ? payload.bundle.schema
      : {};
  const defaults =
    typeof payload.bundle?.defaults === "object" && payload.bundle.defaults !== null
      ? payload.bundle.defaults
      : {};
  const assets = Array.isArray(payload.bundle?.assets) ? payload.bundle.assets : [];

  return {
    layerId: payload.layerId,
    category: payload.category,
    presetId: payload.presetId ?? null,
    durationMs: typeof payload.durationMs === "number" ? payload.durationMs : null,
    backgroundMode: payload.backgroundMode,
    layout: payload.layout,
    zIndex: payload.zIndex,
    manifest: {
      name: (manifest as Record<string, unknown>).name ?? null,
      version: (manifest as Record<string, unknown>).version ?? null,
      type: (manifest as Record<string, unknown>).type ?? null,
      render,
    },
    htmlLength: typeof payload.bundle?.html === "string" ? payload.bundle.html.length : 0,
    cssLength: typeof payload.bundle?.css === "string" ? payload.bundle.css.length : 0,
    schemaKeys: Object.keys(schema),
    defaultsKeys: Object.keys(defaults),
    valuesKeys: Object.keys(values),
    valuesCount: Object.keys(values).length,
    assetsCount: assets.length,
    assetIds: assets.map((asset) => asset.assetId),
  };
}

/**
 * Build a structured diagnostic summary for an untrusted raw payload.
 *
 * @param payload Untrusted incoming payload.
 * @returns Compact diagnostic object for logs.
 */
export function summarizeRawPayload(
  payload: unknown
): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const bundle =
    typeof record.bundle === "object" && record.bundle !== null
      ? (record.bundle as Record<string, unknown>)
      : null;
  const values =
    typeof record.values === "object" && record.values !== null
      ? (record.values as Record<string, unknown>)
      : null;
  const manifest =
    bundle && typeof bundle.manifest === "object" && bundle.manifest !== null
      ? (bundle.manifest as Record<string, unknown>)
      : null;

  return {
    layerId: record.layerId ?? null,
    category: record.category ?? null,
    presetId: record.presetId ?? null,
    durationMs: record.durationMs ?? null,
    backgroundMode: record.backgroundMode ?? null,
    layout: record.layout ?? null,
    zIndex: record.zIndex ?? null,
    manifest: {
      name: manifest?.name ?? null,
      version: manifest?.version ?? null,
      type: manifest?.type ?? null,
      render: manifest?.render ?? null,
    },
    htmlLength: typeof bundle?.html === "string" ? bundle.html.length : 0,
    cssLength: typeof bundle?.css === "string" ? bundle.css.length : 0,
    valuesKeys: values ? Object.keys(values) : [],
  };
}
