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

export type TemplateValidationResultT = {
  assetIds: Set<string>;
};

/**
 * Remove CSS block comments before validation/rendering.
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
 * Validate and sanitize HTML/CSS templates.
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
  const combined = `${html}\n${css}`;
  for (const match of combined.matchAll(ASSET_URL_PATTERN)) {
    if (match[1]) {
      assetIds.add(match[1]);
    }
  }

  return { assetIds };
}
