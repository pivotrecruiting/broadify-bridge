const SCRIPT_PATTERN = /<script\b/i;
const EVENT_HANDLER_PATTERN = /\bon\w+\s*=/i;
const IFRAME_PATTERN = /<iframe\b/i;
const OBJECT_PATTERN = /<object\b/i;
const EMBED_PATTERN = /<embed\b/i;
const LINK_PATTERN = /<link\b/i;
const JAVASCRIPT_URL_PATTERN = /javascript:/i;
const EXTERNAL_URL_PATTERN = /(https?:\/\/|data:|file:|ftp:)/i;
const IMPORT_PATTERN = /@import/i;
const STYLE_BREAKOUT_PATTERN = /<\/style>/i;
const ASSET_URL_PATTERN = /asset:\/\/([a-zA-Z0-9_-]+)/g;
const BACKDROP_FILTER_PATTERN = /backdrop-filter\s*:/i;
const FILTER_PATTERN = /(^|[;{]\s*)filter\s*:/i;
const BLUR_PATTERN = /blur\(\s*([0-9.]+)px\s*\)/gi;
const BOX_SHADOW_DECLARATION_PATTERN = /box-shadow\s*:[^;]+/gi;
const PX_VALUE_PATTERN = /([0-9.]+)px/gi;
const ANIMATED_FILTER_PATTERN = /@(keyframes|-\w+-keyframes)[\s\S]*filter\s*:/i;
const LARGE_BLUR_PX = 24;
const LARGE_BOX_SHADOW_PX = 80;

export type TemplateValidationResultT = {
  assetIds: Set<string>;
  warnings: string[];
};

/**
 * Remove CSS block comments before validation/rendering.
 *
 * @param css Raw CSS string.
 * @returns CSS without block comments.
 */
export function sanitizeTemplateCss(css: string): string {
  if (!css) {
    return "";
  }

  let result = "";
  let inComment = false;
  let inString: "'" | "\"" | null = null;
  let escaped = false;

  for (let i = 0; i < css.length; i += 1) {
    const char = css[i];
    const next = i + 1 < css.length ? css[i + 1] : "";

    if (inComment) {
      if (char === "*" && next === "/") {
        inComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      result += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      inString = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "*") {
      inComment = true;
      i += 1;
      continue;
    }

    result += char;
  }

  return result.trim();
}

/**
 * Validate HTML/CSS templates against a safe subset.
 *
 * @param html Raw HTML template string.
 * @param css Raw CSS template string.
 * @returns Validation result with referenced asset ids.
 */
export function validateTemplate(html: string, css: string): TemplateValidationResultT {
  if (SCRIPT_PATTERN.test(html)) {
    throw new Error("Template HTML contains <script> tags");
  }
  if (EVENT_HANDLER_PATTERN.test(html)) {
    throw new Error("Template HTML contains inline event handlers");
  }
  if (IFRAME_PATTERN.test(html)) {
    throw new Error("Template HTML contains iframes");
  }
  if (OBJECT_PATTERN.test(html) || EMBED_PATTERN.test(html)) {
    throw new Error("Template HTML contains embed/object tags");
  }
  if (LINK_PATTERN.test(html)) {
    throw new Error("Template HTML contains <link> tags");
  }
  if (JAVASCRIPT_URL_PATTERN.test(html) || JAVASCRIPT_URL_PATTERN.test(css)) {
    throw new Error("Template contains javascript: URLs");
  }
  if (EXTERNAL_URL_PATTERN.test(html) || EXTERNAL_URL_PATTERN.test(css)) {
    throw new Error("Template contains external URLs");
  }
  if (STYLE_BREAKOUT_PATTERN.test(css)) {
    throw new Error("Template CSS contains </style> sequences");
  }
  if (IMPORT_PATTERN.test(css)) {
    throw new Error("Template CSS contains @import rules");
  }

  const assetIds = new Set<string>();
  const warnings: string[] = [];
  const combined = `${html}\n${css}`;
  for (const match of combined.matchAll(ASSET_URL_PATTERN)) {
    if (match[1]) {
      assetIds.add(match[1]);
    }
  }

  if (FILTER_PATTERN.test(css)) {
    warnings.push("Template CSS uses filter; this can stress Chromium GPU rendering");
  }
  if (BACKDROP_FILTER_PATTERN.test(css)) {
    warnings.push("Template CSS uses backdrop-filter; this can stress Chromium GPU rendering");
  }
  for (const match of css.matchAll(BLUR_PATTERN)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= LARGE_BLUR_PX) {
      warnings.push(`Template CSS uses large blur(${value}px)`);
      break;
    }
  }
  for (const declaration of css.matchAll(BOX_SHADOW_DECLARATION_PATTERN)) {
    const values = declaration[0].matchAll(PX_VALUE_PATTERN);
    for (const match of values) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value >= LARGE_BOX_SHADOW_PX) {
        warnings.push(`Template CSS uses large box-shadow radius/spread (${value}px)`);
        break;
      }
    }
    if (warnings.some((warning) => warning.includes("box-shadow"))) {
      break;
    }
  }
  if (ANIMATED_FILTER_PATTERN.test(css)) {
    warnings.push("Template CSS animates filter properties");
  }

  return { assetIds, warnings };
}
