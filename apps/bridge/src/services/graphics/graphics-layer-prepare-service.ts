import { assetRegistry } from "./asset-registry.js";
import type {
  GraphicsOutputKeyT,
  GraphicsSendPayloadT,
} from "./graphics-schemas.js";
import { sanitizeTemplateCss, validateTemplate } from "./template-sanitizer.js";
import { deriveTemplateBindings } from "./template-bindings.js";
import type { GraphicsRenderer } from "./renderer/graphics-renderer.js";
import type { PreparedLayerT } from "./graphics-manager-types.js";

const OUTPUT_KEYS_WITH_ALPHA: GraphicsOutputKeyT[] = [
  "key_fill_sdi",
  "key_fill_ndi",
];

/**
 * Prepare a graphics layer payload for safe rendering.
 *
 * Applies security-relevant template sanitization/validation, persists referenced
 * assets, ensures all asset references exist, and derives initial template bindings.
 *
 * @param payload Incoming layer payload.
 * @param outputKey Active output key used for background-mode enforcement.
 * @param renderer Graphics renderer used to refresh resolved asset map.
 * @returns Prepared payload ready for render.
 */
export async function prepareLayerForRender(
  payload: GraphicsSendPayloadT,
  outputKey: GraphicsOutputKeyT | null,
  renderer: GraphicsRenderer
): Promise<PreparedLayerT> {
  // Sanitize CSS before validation to avoid style/script injection vectors.
  const sanitizedCss = sanitizeTemplateCss(payload.bundle.css);
  const sanitizedBundle = {
    ...payload.bundle,
    css: sanitizedCss,
  };
  // Validate template HTML/CSS against a safe subset (no scripts/externals).
  const { assetIds } = validateTemplate(payload.bundle.html, sanitizedCss);

  for (const asset of sanitizedBundle.assets || []) {
    await assetRegistry.storeAsset(asset);
  }

  for (const assetId of assetIds) {
    if (!assetRegistry.getAsset(assetId)) {
      throw new Error(`Missing asset reference: ${assetId}`);
    }
  }

  // Provide renderer a resolved asset map (file paths only, no raw data).
  await renderer.setAssets(assetRegistry.getAssetMap());

  // If output supports alpha, enforce transparent background regardless of payload.
  const enforcedBackground = OUTPUT_KEYS_WITH_ALPHA.includes(outputKey ?? "stub")
    ? "transparent"
    : payload.backgroundMode;

  const initialValues = {
    ...(sanitizedBundle.defaults || {}),
    ...(payload.values || {}),
  };

  const bindings = deriveTemplateBindings(sanitizedBundle, initialValues);

  return {
    ...payload,
    bundle: sanitizedBundle,
    backgroundMode: enforcedBackground,
    values: initialValues,
    bindings,
  };
}
