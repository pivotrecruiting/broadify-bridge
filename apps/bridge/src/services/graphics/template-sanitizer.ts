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
